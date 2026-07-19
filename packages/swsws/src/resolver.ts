/**
 * Route resolution moved to @capsium/core (it is reactor-shared domain
 * logic: the Node reactor uses it too). This module re-exports it so
 * existing imports keep working.
 */
export {
  INTROSPECTION_PATHS,
  matchIntrospection,
  RouteResolver,
  type IntrospectionEndpoint,
  type Resolution,
} from '@capsium/core';
