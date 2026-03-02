export interface ErrorLogMessage {
  remoteAddress: string;
  remotePort: string;
  url: string;
  error: unknown;
}

export interface ResponseLogMessage {
  remoteAddress: string;
  remotePort: string;
  url: string;
}
