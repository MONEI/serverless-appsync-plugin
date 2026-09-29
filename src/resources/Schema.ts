import globby from 'globby';
import fs from 'fs';
import path from 'path';
import { CfnResources } from '../types/cloudFormation';
import { Api } from './Api';
import { flatten } from 'lodash';
import { parse, print, Kind, DefinitionNode } from 'graphql';
import { validateSDL } from 'graphql/validation/validate';
import { mergeTypeDefs } from '@graphql-tools/merge';

const AWS_TYPES = `
directive @aws_iam on FIELD_DEFINITION | OBJECT
directive @aws_oidc on FIELD_DEFINITION | OBJECT
directive @aws_api_key on FIELD_DEFINITION | OBJECT
directive @aws_lambda on FIELD_DEFINITION | OBJECT
directive @aws_auth(cognito_groups: [String]) on FIELD_DEFINITION | OBJECT
directive @aws_cognito_user_pools(
  cognito_groups: [String]
) on FIELD_DEFINITION | OBJECT
directive @aws_subscribe(mutations: [String]) on FIELD_DEFINITION
directive @canonical on OBJECT | FIELD_DEFINITION
directive @hidden on OBJECT | FIELD_DEFINITION
directive @renamed on OBJECT | FIELD_DEFINITION
scalar AWSDate
scalar AWSTime
scalar AWSDateTime
scalar AWSTimestamp
scalar AWSEmail
scalar AWSJSON
scalar AWSURL
scalar AWSPhone
scalar AWSIPAddress
`;

// The directive and scalar names AppSync provides itself (derived from
// AWS_TYPES so the two never drift). User schemas that redeclare any of these
// — often to satisfy a schema linter — must have the redeclaration stripped,
// otherwise validation sees a duplicate definition and AppSync rejects the
// upload.
const reservedNames = ((): {
  directives: Set<string>;
  types: Set<string>;
} => {
  const directives = new Set<string>();
  const types = new Set<string>();
  for (const def of parse(AWS_TYPES).definitions) {
    if (def.kind === Kind.DIRECTIVE_DEFINITION) {
      directives.add(def.name.value);
    } else if ('name' in def && def.name) {
      types.add(def.name.value);
    }
  }
  return { directives, types };
})();

export class Schema {
  constructor(private api: Api, private schemas: string[]) {}

  compile(): CfnResources {
    const logicalId = this.api.naming.getSchemaLogicalId();

    return {
      [logicalId]: {
        Type: 'AWS::AppSync::GraphQLSchema',
        Properties: {
          Definition: this.generateSchema(),
          ApiId: this.api.getApiId(),
        },
      },
    };
  }

  validateSchema(schema: string) {
    const errors = validateSDL(parse(schema));
    if (errors.length > 0) {
      throw new this.api.plugin.serverless.classes.Error(
        'Invalid GraphQL schema:\n' +
          errors.map((error) => `     ${error.message}`).join('\n'),
      );
    }
  }

  // AppSync does not support descriptions from June 2018 spec
  // https://spec.graphql.org/June2018/#sec-Descriptions
  // so they need to be converted to comments, the space after the # will also be included
  // by AppSync in the generated description so we remove it
  convertDescriptions(schema: string): string {
    const lines = schema.split('\n');
    const singleLineComment = /^(?<indent> *)"(?<comment>[^"]+?)"$/;
    const singleLineMultilineComment = /^(?<indent> *)"""(?<comment>.+?)"""$/;
    const multilineCommentDelimiter = /^(?<indent> *)"""$/;

    let inComment = false;
    let result = '';

    for (const line of lines) {
      switch (true) {
        case singleLineComment.test(line):
          result += `${line.match(singleLineComment)?.groups?.indent}#${
            line.match(singleLineComment)?.groups?.comment
          }\n`;
          break;
        case singleLineMultilineComment.test(line):
          result += `${
            line.match(singleLineMultilineComment)?.groups?.indent
          }#${line.match(singleLineMultilineComment)?.groups?.comment}\n`;
          break;
        case multilineCommentDelimiter.test(line):
          inComment = !inComment;
          break;
        case inComment:
          result += `${
            line.match(/^(?<indent> *)/)?.groups?.indent
          }#${line.trimStart()}\n`;
          break;
        default:
          result += line + '\n';
      }
    }

    return result;
  }

  generateSchema() {
    const schemaFiles = flatten(
      globby.sync(
        this.schemas.map((schema) =>
          path
            // `path.resolve` keeps relative paths resolved against the
            // service directory while leaving absolute paths untouched
            // (`path.join` would incorrectly prefix them with servicePath).
            .resolve(this.api.plugin.serverless.config.servicePath, schema)
            .replace(/\\/g, '/'),
        ),
      ),
    );

    const schemas = schemaFiles.map((file) => {
      return this.stripReservedDefinitions(fs.readFileSync(file, 'utf8'));
    });

    this.validateSchema(AWS_TYPES + '\n' + schemas.join('\n'));

    // Return single (already stripped) files as-is.
    if (schemas.length === 1) {
      return this.convertDescriptions(schemas[0]);
    }

    // AppSync does not support Object extensions
    // https://spec.graphql.org/October2021/#sec-Object-Extensions
    // Merge the schemas
    return this.convertDescriptions(
      print(
        mergeTypeDefs(schemas, {
          forceSchemaDefinition: false,
          useSchemaDefinition: false,
          sort: true,
          throwOnConflict: true,
        }),
      ),
    );
  }

  // AppSync provides its own directives (@aws_*, plus the plugin's merge
  // directives) and scalars (AWSJSON, AWSDateTime, ...). Users sometimes also
  // declare them — e.g. to satisfy a schema linter — which collides with the
  // definitions we prepend for validation and is rejected by AppSync on
  // deploy. Strip any such redeclaration, leaving the original text untouched
  // when there is nothing to remove.
  stripReservedDefinitions(schema: string): string {
    const doc = parse(schema);
    const definitions = doc.definitions.filter(
      (def) => !isReservedDefinition(def),
    );
    if (definitions.length === doc.definitions.length) {
      return schema;
    }
    return print({ ...doc, definitions });
  }
}

function isReservedDefinition(def: DefinitionNode): boolean {
  if (def.kind === Kind.DIRECTIVE_DEFINITION) {
    return reservedNames.directives.has(def.name.value);
  }
  if ('name' in def && def.name) {
    return reservedNames.types.has(def.name.value);
  }
  return false;
}
