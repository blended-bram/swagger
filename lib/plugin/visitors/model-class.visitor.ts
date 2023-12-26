import { compact, flatten, head } from 'lodash';
import { posix } from 'path';
import * as ts from 'typescript';
import { PropertyAssignment, factory } from 'typescript';
import { ApiHideProperty } from '../../decorators';
import { PluginOptions } from '../merge-options';
import { METADATA_FACTORY_NAME } from '../plugin-constants';
import { pluginDebugLogger } from '../plugin-debug-logger';
import {
  createBooleanLiteral,
  createLiteralFromAnyValue,
  createPrimitiveLiteral,
  getDecoratorArguments,
  getMainCommentOfNode,
  getText,
  getTsDocTagsOfNode,
  isEnum
} from '../utils/ast-utils';
import {
  canReferenceNode,
  convertPath,
  extractTypeArgumentIfArray,
  getDecoratorOrUndefinedByNames,
  getTypeReferenceAsString,
  hasPropertyKey,
  isAutoGeneratedEnumUnion,
  isAutoGeneratedTypeUnion
} from '../utils/plugin-utils';
import { typeReferenceToIdentifier } from '../utils/type-reference-to-identifier.util';
import { AbstractFileVisitor } from './abstract.visitor';

type ClassMetadata = Record<string, ts.ObjectLiteralExpression>;

export class ModelClassVisitor extends AbstractFileVisitor {
  private readonly _typeImports: Record<string, string> = {};
  private readonly _collectedMetadata: Record<string, ClassMetadata> = {};

  get typeImports() {
    return this._typeImports;
  }

  get collectedMetadata(): Array<
    [ts.CallExpression, Record<string, ClassMetadata>]
  > {
    const metadataWithImports = [];
    Object.keys(this._collectedMetadata).forEach((filePath) => {
      const metadata = this._collectedMetadata[filePath];
      const path = filePath.replace(/\.[jt]s$/, '');
      const importExpr = ts.factory.createCallExpression(
        ts.factory.createToken(ts.SyntaxKind.ImportKeyword) as ts.Expression,
        undefined,
        [ts.factory.createStringLiteral(path)]
      );
      metadataWithImports.push([importExpr, metadata]);
    });
    return metadataWithImports;
  }

  visit(
    sourceFile: ts.SourceFile,
    ctx: ts.TransformationContext,
    program: ts.Program,
    options: PluginOptions
  ) {
    const typeChecker = program.getTypeChecker();
    sourceFile = this.updateImports(sourceFile, ctx.factory, program);

    const propertyNodeVisitorFactory =
      (metadata: ClassMetadata) =>
      (node: ts.Node): ts.Node => {
        const visit = () => {
          if (ts.isPropertyDeclaration(node)) {
            this.visitPropertyNodeDeclaration(
              node,
              ctx,
              typeChecker,
              options,
              sourceFile,
              metadata
            );
          }
          return node;
        };
        const visitedNode = visit();
        if (!options.readonly) {
          return visitedNode;
        }
      };

    const visitClassNode = (node: ts.Node): ts.Node => {
      if (ts.isClassDeclaration(node)) {
        const metadata: ClassMetadata = {};
        const isExported = node.modifiers?.some(
          (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword
        );

        if (options.readonly) {
          if (isExported) {
            ts.forEachChild(node, propertyNodeVisitorFactory(metadata));
          } else {
            if (options.debug) {
              pluginDebugLogger.debug(
                `Skipping class "${node.name.getText()}" because it's not exported.`
              );
            }
          }
        } else {
          node = ts.visitEachChild(
            node,
            propertyNodeVisitorFactory(metadata),
            ctx
          );
        }

        if ((isExported && options.readonly) || !options.readonly) {
          const declaration = this.addMetadataFactory(
            ctx.factory,
            node as ts.ClassDeclaration,
            metadata,
            sourceFile,
            options
          );

          if (!options.readonly) {
            return declaration;
          }
        }
      }

      if (options.readonly) {
        ts.forEachChild(node, visitClassNode);
      } else {
        return ts.visitEachChild(node, visitClassNode, ctx);
      }
    };
    return ts.visitNode(sourceFile, visitClassNode);
  }

  visitPropertyNodeDeclaration(
    node: ts.PropertyDeclaration,
    ctx: ts.TransformationContext,
    typeChecker: ts.TypeChecker,
    options: PluginOptions,
    sourceFile: ts.SourceFile,
    metadata: ClassMetadata
  ) {
    const decorators = ts.canHaveDecorators(node) && ts.getDecorators(node);

    const hidePropertyDecorator = getDecoratorOrUndefinedByNames(
      [ApiHideProperty.name],
      decorators,
      factory
    );
    if (hidePropertyDecorator) {
      return node;
    }

    const isPropertyStatic = (node.modifiers || []).some(
      (modifier: ts.Modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword
    );
    if (isPropertyStatic) {
      return node;
    }
    try {
      this.inspectPropertyDeclaration(
        ctx.factory,
        node,
        typeChecker,
        options,
        sourceFile.fileName,
        sourceFile,
        metadata
      );
    } catch (err) {
      return node;
    }
  }

  addMetadataFactory(
    factory: ts.NodeFactory,
    node: ts.ClassDeclaration,
    classMetadata: ClassMetadata,
    sourceFile: ts.SourceFile,
    options: PluginOptions
  ) {
    const returnValue = factory.createObjectLiteralExpression(
      Object.keys(classMetadata).map((key) =>
        factory.createPropertyAssignment(
          factory.createIdentifier(key),
          classMetadata[key]
        )
      )
    );

    if (options.readonly) {
      const filePath = this.normalizeImportPath(
        options.pathToSource,
        sourceFile.fileName
      );
      if (!this._collectedMetadata[filePath]) {
        this._collectedMetadata[filePath] = {};
      }
      const attributeKey = node.name.getText();
      this._collectedMetadata[filePath][attributeKey] = returnValue;
      return;
    }

    const method = factory.createMethodDeclaration(
      [factory.createModifier(ts.SyntaxKind.StaticKeyword)],
      undefined,
      factory.createIdentifier(METADATA_FACTORY_NAME),
      undefined,
      undefined,
      [],
      undefined,
      factory.createBlock([factory.createReturnStatement(returnValue)], true)
    );

    return factory.updateClassDeclaration(
      node,
      node.modifiers,
      node.name,
      node.typeParameters,
      node.heritageClauses,
      [...node.members, method]
    );
  }

  inspectPropertyDeclaration(
    factory: ts.NodeFactory,
    compilerNode: ts.PropertyDeclaration,
    typeChecker: ts.TypeChecker,
    options: PluginOptions,
    hostFilename: string,
    sourceFile: ts.SourceFile,
    metadata: ClassMetadata
  ) {
    const objectLiteralExpr = this.createDecoratorObjectLiteralExpr(
      factory,
      compilerNode,
      typeChecker,
      factory.createNodeArray(),
      options,
      hostFilename,
      sourceFile
    );
    this.addClassMetadata(
      compilerNode,
      objectLiteralExpr,
      sourceFile,
      metadata
    );
  }

  createDecoratorObjectLiteralExpr(
    factory: ts.NodeFactory,
    node: ts.PropertyDeclaration | ts.PropertySignature,
    typeChecker: ts.TypeChecker,
    existingProperties: ts.NodeArray<ts.PropertyAssignment> = factory.createNodeArray(),
    options: PluginOptions = {},
    hostFilename = '',
    sourceFile?: ts.SourceFile
  ): ts.ObjectLiteralExpression {
    const isRequired = !node.questionToken;

    const properties = [
      ...existingProperties,
      !hasPropertyKey('required', existingProperties) &&
        factory.createPropertyAssignment(
          'required',
          createBooleanLiteral(factory, isRequired)
        ),
      ...this.createTypePropertyAssignments(
        factory,
        node.type,
        typeChecker,
        existingProperties,
        hostFilename,
        options
      ),
      ...this.createDescriptionAndTsDocTagPropertyAssigments(
        factory,
        node,
        typeChecker,
        existingProperties,
        options,
        sourceFile
      ),
      this.createDefaultPropertyAssignment(
        factory,
        node,
        existingProperties,
        options
      ),
      this.createEnumPropertyAssignment(
        factory,
        node,
        typeChecker,
        existingProperties,
        hostFilename,
        options
      )
    ];
    if (options.classValidatorShim) {
      properties.push(
        this.createValidationPropertyAssignments(factory, node, options)
      );
    }
    return factory.createObjectLiteralExpression(compact(flatten(properties)));
  }

  /**
   * Returns an array with 0..2 "ts.PropertyAssignment"s.
   * The first one is the "type" property assignment, the second one is the "nullable" property assignment.
   * When type cannot be determined, an empty array is returned.
   */
  private createTypePropertyAssignments(
    factory: ts.NodeFactory,
    node: ts.TypeNode | undefined,
    typeChecker: ts.TypeChecker,
    existingProperties: ts.NodeArray<ts.PropertyAssignment>,
    hostFilename: string,
    options: PluginOptions
  ): ts.PropertyAssignment[] {
    const key = 'type';
    if (hasPropertyKey(key, existingProperties)) {
      return [];
    }

    if (node) {
      if (ts.isTypeLiteralNode(node)) {
        const initializer = this.createInitializerForTypeLiteralNode(
          node,
          factory,
          typeChecker,
          existingProperties,
          hostFilename,
          options
        );
        return [factory.createPropertyAssignment(key, initializer)];
      } else if (ts.isUnionTypeNode(node)) {
        const { nullableType, isNullable } = this.isNullableUnion(node);
        const remainingTypes = node.types.filter(
          (item) => item !== nullableType
        );

        // TODO: When we have more than 1 type left, we could use "oneOf"
        if (remainingTypes.length === 1) {
          const propertyAssignments = this.createTypePropertyAssignments(
            factory,
            remainingTypes[0],
            typeChecker,
            existingProperties,
            hostFilename,
            options
          );
          if (!isNullable) {
            return propertyAssignments;
          }
          return [
            ...propertyAssignments,
            factory.createPropertyAssignment(
              'nullable',
              createBooleanLiteral(factory, true)
            )
          ];
        }
      }
    }

    const type = typeChecker.getTypeAtLocation(node);
    if (!type) {
      return [];
    }

    const typeReferenceDescriptor = getTypeReferenceAsString(type, typeChecker);
    if (!typeReferenceDescriptor.typeName) {
      return [];
    }

    const identifier = typeReferenceToIdentifier(
      typeReferenceDescriptor,
      hostFilename,
      options,
      factory,
      type,
      this._typeImports
    );

    const initializer = factory.createArrowFunction(
      undefined,
      undefined,
      [],
      undefined,
      undefined,
      identifier
    );
    return [factory.createPropertyAssignment(key, initializer)];
  }

  createInitializerForTypeLiteralNode(
    node: ts.TypeLiteralNode,
    factory: ts.NodeFactory,
    typeChecker: ts.TypeChecker,
    existingProperties: ts.NodeArray<ts.PropertyAssignment>,
    hostFilename: string,
    options: PluginOptions
  ) {
    const propertyAssignments = Array.from(node.members || []).map((member) => {
      const literalExpr = this.createDecoratorObjectLiteralExpr(
        factory,
        member as ts.PropertySignature,
        typeChecker,
        existingProperties,
        options,
        hostFilename
      );
      return factory.createPropertyAssignment(
        factory.createIdentifier(member.name.getText()),
        literalExpr
      );
    });
    const initializer = factory.createArrowFunction(
      undefined,
      undefined,
      [],
      undefined,
      undefined,
      factory.createParenthesizedExpression(
        factory.createObjectLiteralExpression(propertyAssignments)
      )
    );
    return initializer;
  }

  isNullableUnion(node: ts.UnionTypeNode) {
    const nullableType = node.types.find(
      (type) =>
        type.kind === ts.SyntaxKind.NullKeyword ||
        (ts.SyntaxKind.LiteralType && type.getText() === 'null')
    );
    const isNullable = !!nullableType;
    return { nullableType, isNullable };
  }

  createEnumPropertyAssignment(
    factory: ts.NodeFactory,
    node: ts.PropertyDeclaration | ts.PropertySignature,
    typeChecker: ts.TypeChecker,
    existingProperties: ts.NodeArray<ts.PropertyAssignment>,
    hostFilename: string,
    options: PluginOptions
  ) {
    const key = 'enum';
    if (hasPropertyKey(key, existingProperties)) {
      return undefined;
    }
    let type = typeChecker.getTypeAtLocation(node);
    if (!type) {
      return undefined;
    }
    if (isAutoGeneratedTypeUnion(type)) {
      const types = (type as ts.UnionOrIntersectionType).types;
      type = types[types.length - 1];
    }
    const typeIsArrayTuple = extractTypeArgumentIfArray(type);
    if (!typeIsArrayTuple) {
      return undefined;
    }
    let isArrayType = typeIsArrayTuple.isArray;
    type = typeIsArrayTuple.type;

    const isEnumMember =
      type.symbol && type.symbol.flags === ts.SymbolFlags.EnumMember;
    if (!isEnum(type) || isEnumMember) {
      if (!isEnumMember) {
        type = isAutoGeneratedEnumUnion(type, typeChecker);
      }
      if (!type) {
        return undefined;
      }
      const typeIsArrayTuple = extractTypeArgumentIfArray(type);
      if (!typeIsArrayTuple) {
        return undefined;
      }
      isArrayType = typeIsArrayTuple.isArray;
      type = typeIsArrayTuple.type;
    }

    const typeReferenceDescriptor = { typeName: getText(type, typeChecker) };
    const enumIdentifier = typeReferenceToIdentifier(
      typeReferenceDescriptor,
      hostFilename,
      options,
      factory,
      type,
      this._typeImports
    );

    const enumProperty = factory.createPropertyAssignment(key, enumIdentifier);

    if (isArrayType) {
      const isArrayKey = 'isArray';
      const isArrayProperty = factory.createPropertyAssignment(
        isArrayKey,
        factory.createIdentifier('true')
      );
      return [enumProperty, isArrayProperty];
    }
    return enumProperty;
  }

  createDefaultPropertyAssignment(
    factory: ts.NodeFactory,
    node: ts.PropertyDeclaration | ts.PropertySignature,
    existingProperties: ts.NodeArray<ts.PropertyAssignment>,
    options: PluginOptions
  ) {
    const key = 'default';
    if (hasPropertyKey(key, existingProperties)) {
      return undefined;
    }
    let initializer = (node as ts.PropertyDeclaration).initializer;
    if (!initializer) {
      return undefined;
    }
    if (ts.isAsExpression(initializer)) {
      initializer = initializer.expression;
    }
    initializer =
      this.clonePrimitiveLiteral(factory, initializer) ?? initializer;

    if (!canReferenceNode(initializer, options)) {
      const parentFilePath = node.getSourceFile().fileName;
      const propertyName = node.name.getText();
      pluginDebugLogger.debug(
        `Skipping registering default value for "${propertyName}" property in "${parentFilePath}" file because it is not a referenceable value ("${initializer.getText()}").`
      );
      return undefined;
    }
    return factory.createPropertyAssignment(key, initializer);
  }

  createValidationPropertyAssignments(
    factory: ts.NodeFactory,
    node: ts.PropertyDeclaration | ts.PropertySignature,
    options: PluginOptions
  ): ts.PropertyAssignment[] {
    const assignments = [];
    const decorators = ts.canHaveDecorators(node) && ts.getDecorators(node);

    if (!options.readonly) {
      // @IsIn() annotation is not supported in readonly mode
      this.addPropertyByValidationDecorator(
        factory,
        'IsIn',
        'enum',
        decorators,
        assignments,
        options
      );
    }
    this.addPropertyByValidationDecorator(
      factory,
      'Min',
      'minimum',
      decorators,
      assignments,
      options
    );
    this.addPropertyByValidationDecorator(
      factory,
      'Max',
      'maximum',
      decorators,
      assignments,
      options
    );
    this.addPropertyByValidationDecorator(
      factory,
      'MinLength',
      'minLength',
      decorators,
      assignments,
      options
    );
    this.addPropertyByValidationDecorator(
      factory,
      'MaxLength',
      'maxLength',
      decorators,
      assignments,
      options
    );
    this.addPropertiesByValidationDecorator(
      factory,
      'IsPositive',
      decorators,
      assignments,
      () => {
        return [
          factory.createPropertyAssignment(
            'minimum',
            createPrimitiveLiteral(factory, 1)
          )
        ];
      }
    );
    this.addPropertiesByValidationDecorator(
      factory,
      'IsNegative',
      decorators,
      assignments,
      () => {
        return [
          factory.createPropertyAssignment(
            'maximum',
            createPrimitiveLiteral(factory, -1)
          )
        ];
      }
    );
    this.addPropertiesByValidationDecorator(
      factory,
      'Length',
      decorators,
      assignments,
      (decoratorRef: ts.Decorator) => {
        const decoratorArguments = getDecoratorArguments(decoratorRef);
        const result = [];

        const minLength = head(decoratorArguments);
        if (!canReferenceNode(minLength, options)) {
          return result;
        }

        const clonedMinLength = this.clonePrimitiveLiteral(factory, minLength) ?? minLength;
        if (clonedMinLength) {
          result.push(
            factory.createPropertyAssignment('minLength', clonedMinLength)
          );
        }

        if (decoratorArguments.length > 1) {
          const maxLength = decoratorArguments[1];
          if (!canReferenceNode(maxLength, options)) {
            return result;
          }
          const clonedMaxLength = this.clonePrimitiveLiteral(
            factory,
            maxLength
          ) ?? maxLength;
          if (clonedMaxLength) {
            result.push(
              factory.createPropertyAssignment('maxLength', clonedMaxLength)
            );
          }
        }

        return result;
      }
    );
    this.addPropertiesByValidationDecorator(
      factory,
      'Matches',
      decorators,
      assignments,
      (decoratorRef: ts.Decorator) => {
        const decoratorArguments = getDecoratorArguments(decoratorRef);
        return [
          factory.createPropertyAssignment(
            'pattern',
            createPrimitiveLiteral(factory, head(decoratorArguments).text)
          )
        ];
      }
    );

    return assignments;
  }

  addPropertyByValidationDecorator(
    factory: ts.NodeFactory,
    decoratorName: string,
    propertyKey: string,
    decorators: readonly ts.Decorator[],
    assignments: ts.PropertyAssignment[],
    options: PluginOptions
  ) {
    this.addPropertiesByValidationDecorator(
      factory,
      decoratorName,
      decorators,
      assignments,
      (decoratorRef: ts.Decorator) => {
        const argument: ts.Expression = head(
          getDecoratorArguments(decoratorRef)
        );
        const assignment =
          this.clonePrimitiveLiteral(factory, argument) ?? argument;
        if (!canReferenceNode(assignment, options)) {
          return [];
        }
        return [factory.createPropertyAssignment(propertyKey, assignment)];
      }
    );
  }

  addPropertiesByValidationDecorator(
    factory: ts.NodeFactory,
    decoratorName: string,
    decorators: readonly ts.Decorator[],
    assignments: ts.PropertyAssignment[],
    addPropertyAssignments: (decoratorRef: ts.Decorator) => PropertyAssignment[]
  ) {
    const decoratorRef: ts.Decorator = getDecoratorOrUndefinedByNames(
      [decoratorName],
      decorators,
      factory
    );
    if (!decoratorRef) {
      return;
    }
    assignments.push(...addPropertyAssignments(decoratorRef));
  }

  addClassMetadata(
    node: ts.PropertyDeclaration,
    objectLiteral: ts.ObjectLiteralExpression,
    sourceFile: ts.SourceFile,
    metadata: ClassMetadata
  ) {
    const hostClass = node.parent;
    const className = hostClass.name && hostClass.name.getText();
    if (!className) {
      return;
    }
    const propertyName = node.name && node.name.getText(sourceFile);
    if (
      !propertyName ||
      (node.name && node.name.kind === ts.SyntaxKind.ComputedPropertyName)
    ) {
      return;
    }
    metadata[propertyName] = objectLiteral;
  }

  createDescriptionAndTsDocTagPropertyAssigments(
    factory: ts.NodeFactory,
    node: ts.PropertyDeclaration | ts.PropertySignature,
    typeChecker: ts.TypeChecker,
    existingProperties: ts.NodeArray<ts.PropertyAssignment> = factory.createNodeArray(),
    options: PluginOptions = {},
    sourceFile?: ts.SourceFile
  ): ts.PropertyAssignment[] {
    if (!options.introspectComments || !sourceFile) {
      return [];
    }
    const propertyAssignments = [];
    const comments = getMainCommentOfNode(node, sourceFile);
    const tags = getTsDocTagsOfNode(node, sourceFile, typeChecker);

    const keyOfComment = options.dtoKeyOfComment;
    if (!hasPropertyKey(keyOfComment, existingProperties) && comments) {
      const descriptionPropertyAssignment = factory.createPropertyAssignment(
        keyOfComment,
        factory.createStringLiteral(comments)
      );
      propertyAssignments.push(descriptionPropertyAssignment);
    }

    const hasExampleOrExamplesKey =
      hasPropertyKey('example', existingProperties) ||
      hasPropertyKey('examples', existingProperties);
    if (!hasExampleOrExamplesKey && tags.example?.length) {
      if (tags.example.length === 1) {
        const examplePropertyAssignment = factory.createPropertyAssignment(
          'example',
          createLiteralFromAnyValue(factory, tags.example[0])
        );
        propertyAssignments.push(examplePropertyAssignment);
      } else {
        const examplesPropertyAssignment = factory.createPropertyAssignment(
          'examples',
          createLiteralFromAnyValue(factory, tags.example)
        );
        propertyAssignments.push(examplesPropertyAssignment);
      }
    }

    const hasDeprecatedKey = hasPropertyKey('deprecated', existingProperties);
    if (!hasDeprecatedKey && tags.deprecated) {
      const deprecatedPropertyAssignment = factory.createPropertyAssignment(
        'deprecated',
        createLiteralFromAnyValue(factory, tags.deprecated)
      );
      propertyAssignments.push(deprecatedPropertyAssignment);
    }

    return propertyAssignments;
  }

  private normalizeImportPath(pathToSource: string, path: string) {
    let relativePath = posix.relative(
      convertPath(pathToSource),
      convertPath(path)
    );
    relativePath = relativePath[0] !== '.' ? './' + relativePath : relativePath;
    return relativePath;
  }

  private clonePrimitiveLiteral(factory: ts.NodeFactory, node: ts.Node) {
    const primitiveTypeName = this.getInitializerPrimitiveTypeName(node);
    if (!primitiveTypeName) {
      return undefined;
    }
    const text = (node as any).text ?? node.getText();
    return createPrimitiveLiteral(factory, text, primitiveTypeName);
  }

  private getInitializerPrimitiveTypeName(node: ts.Node) {
    if (
      ts.isIdentifier(node) &&
      (node.text === 'true' || node.text === 'false')
    ) {
      return 'boolean';
    }
    if (ts.isNumericLiteral(node) || ts.isPrefixUnaryExpression(node)) {
      return 'number';
    }
    if (ts.isStringLiteral(node)) {
      return 'string';
    }
    return undefined;
  }
}
