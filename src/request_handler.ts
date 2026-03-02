/* eslint-disable @typescript-eslint/no-empty-function */
import * as http from "node:http";
import * as path from "node:path";
import { ErrorLogMessage, ResponseLogMessage } from "./types.js";

export interface RequestHandlerOptions {
  req: http.IncomingMessage;
  res: http.ServerResponse & {
    req: http.IncomingMessage;
  };
  webRoot: string;
  hostName: string;
  base: string;
  errorLog?: (message: ErrorLogMessage) => void;
  responseLog?: (message: ResponseLogMessage) => void;
}

export class RequestHandler {
  protected req: http.IncomingMessage;
  protected res: http.ServerResponse & {
    req: http.IncomingMessage;
  };
  protected resolvedPath: string;
  protected url: URL;
  protected webRoot: string;
  protected hostName: string;
  protected errorLog?: (message: ErrorLogMessage) => void;
  protected responseLog?: (message: ResponseLogMessage) => void;

  constructor({ req, res, webRoot, hostName, base, errorLog, responseLog }: RequestHandlerOptions) {
    this.req = req;
    this.res = res;
    this.webRoot = webRoot;
    this.hostName = hostName;
    this.errorLog = errorLog;
    this.responseLog = responseLog;
    this.url = new URL(this.req.url ?? "/", base);
    // url.pathname is guranteed to have a leading slash.
    // ...trailing slashes are removed unless the path is resolved to the root directory.
    this.resolvedPath = path.resolve(webRoot, `.${this.url.pathname}`);
  }

  public async processRequest() {
    if (!this.resolvedPath.startsWith(this.webRoot)) {
      this.sendHttpResponse(403);
      return;
    }
    switch (this.req.method) {
      case "GET": {
        await this.processGet();
        break;
      }
      case "POST": {
        await this.processPost();
        break;
      }
      default: {
        this.res.setHeader("Allow", "GET, POST");
        this.sendHttpResponse(405);
        break;
      }
    }
  }

  protected async processGet() {}

  protected async processPost() {}

  public sendHttpResponse = (status: number) => {
    const message = `${status.toString()} (${http.STATUS_CODES[status] ?? "Error"})`;
    this.res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
    this.res.end(message);
  };

  public catch = (err: unknown) => {
    this.res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    this.res.end(http.STATUS_CODES[500]);
    if (this.errorLog) {
      this.errorLog({
        remoteAddress: this.req.socket.remoteAddress ?? "",
        remotePort: this.req.socket.remotePort?.toString() ?? "",
        url: this.url.href,
        error: err instanceof Error ? err : new Error(String(err)),
      });
    }
  };
}
