/**
 * authentication.json model (ARCHITECTURE.md §4b). Isomorphic.
 *
 * - basicAuth: reactors challenge (401 + WWW-Authenticate) when enabled;
 *   the htpasswd file is verified with platform tooling (bcrypt/apr1).
 * - oauth2: authorization-code flow; browser reactors use PKCE. Static
 *   provider config travels in the package; SECRETS come from deploy-time
 *   configuration (deploy.json / a deploy config message), never from the
 *   package. Sessions use a signed cookie.
 */
import { z } from 'zod';

export const AUTHENTICATION_FILE = 'authentication.json';

export const basicAuthSchema = z.object({
  enabled: z.boolean(),
  /** Package-relative htpasswd file (e.g. `auth/.htpasswd`). */
  passwdFile: z.string().min(1),
  realm: z.string().min(1).optional(),
});
export type BasicAuth = z.infer<typeof basicAuthSchema>;

export const DEFAULT_BASIC_REALM = 'capsium';

export const oauth2Schema = z.object({
  enabled: z.boolean(),
  provider: z.string().min(1).optional(),
  clientId: z.string().min(1),
  authorizationUrl: z.url(),
  tokenUrl: z.url(),
  userinfoUrl: z.url().optional(),
  /** Package-relative callback path the reactor intercepts (e.g. `/auth/callback`). */
  redirectPath: z.string().min(1),
  scopes: z.array(z.string().min(1)).optional(),
});
export type OAuth2 = z.infer<typeof oauth2Schema>;

export const authenticationSchema = z.object({
  authentication: z.strictObject({
    basicAuth: basicAuthSchema.optional(),
    oauth2: oauth2Schema.optional(),
  }),
});
export type Authentication = z.infer<typeof authenticationSchema>;

export function parseAuthentication(input: unknown): Authentication {
  return authenticationSchema.parse(input);
}
