export interface FakeGoogle {
  url: string;
  issuer: string;
  close(): Promise<void>;
}
export function startFakeGoogle(opts?: {
  port?: number;
  host?: string;
  issuer?: string;
  now?: () => number;
}): Promise<FakeGoogle>;
