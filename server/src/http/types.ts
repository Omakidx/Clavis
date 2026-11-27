export type AuthContext =
  | { kind: 'bearer'; userId: string; familyId: string }
  | {
      kind: 'cookie';
      userId: string;
      sessionId: string;
      csrfToken: string;
      authenticatedAt: Date;
    };

export interface AppVariables {
  requestId: string;
  /** Set once authenticated. The user id comes from the token or session, never from the client. */
  auth?: AuthContext;
  /** Error code of the response, for the access log. */
  errorCode?: string;
}
export type AppEnv = { Variables: AppVariables };
