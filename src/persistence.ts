import * as https from "node:https";
import * as http from "node:http";
import * as path from "node:path";
import { RWDependencyGraph } from "./rw_dependency_graph.js";
import { ErrorLogMessage, ResponseLogMessage } from "./types.js";
import { RequestHandler } from "./request_handler.js";

export interface PersistenceOptions {
  server: http.Server | https.Server;
  webRoot: string;
  hostName: string;
  errorLog?: (message: ErrorLogMessage) => void;
  responseLog?: (message: ResponseLogMessage) => void;
}

export class Persistence {
  protected g: RWDependencyGraph;
  protected server: http.Server;
  protected webRoot: string;
  protected hostName: string;
  protected errorLog?: (message: ErrorLogMessage) => void;
  protected responseLog?: (message: ResponseLogMessage) => void;
  protected base: string;

  constructor({ server, webRoot, hostName, errorLog, responseLog }: PersistenceOptions) {
    this.g = new RWDependencyGraph();
    this.server = server;
    if (!path.isAbsolute(webRoot)) {
      throw new Error(`The web root must be an absolute path: ${webRoot}`);
    }
    this.webRoot = path.resolve(webRoot);
    this.hostName = hostName;
    this.base = `${this.server instanceof https.Server ? "https" : "http"}://${hostName}`;
    this.errorLog = errorLog;
    this.responseLog = responseLog;
    this.server.on("request", this.createRequestHandler);
  }

  protected createRequestHandler = (
    req: http.IncomingMessage,
    res: http.ServerResponse & {
      req: http.IncomingMessage;
    }
  ) => {
    try {
      const requestHandler = new RequestHandler({
        req,
        res,
        webRoot: this.webRoot,
        hostName: this.hostName,
        base: this.base,
        errorLog: this.errorLog,
        responseLog: this.responseLog,
      });
      requestHandler.processRequest().catch(requestHandler.catch);
    } catch (err: unknown) {
      res.writeHead(500);
      res.end(http.STATUS_CODES[500]);
      if (this.errorLog) {
        this.errorLog({
          remoteAddress: req.socket.remoteAddress ?? "",
          remotePort: req.socket.remotePort?.toString() ?? "",
          url: req.url ?? "",
          error: err,
        });
      }
    }
  };
}
