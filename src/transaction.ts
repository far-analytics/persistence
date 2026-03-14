// import * as fsp from "node:fs/promises";
// import { Client } from "./client.js";

// export class Transaction implements Omit<Client, "createTransaction"> {
//   // Construct with specified paths.
//   public read = async (path: string, options?: Parameters<typeof fsp.readFile>[1]): Promise<Buffer | string> => {
//     const uuid = await this.g.acquire(path, "read");
//     const data = await fsp.readFile(path, options);
//     this.g.release(uuid);
//     return data;
//   };

//   public release = (): void => {
//     //
//   };
// }
// //  Could it have its own dependency graph?

// // public createTransaction = async (paths: string[]): Promise<Transaction> => {
// //   /*Return a cline that has `transaction` set to true.  This kind of client will not call acquire. */
// //   await Promise.all();
// //   return this; // Maybe this should be TransactionClient and it will only process the specified paths.  Could have same interface.  Could Implement Client.
// //   // read would look up if path is valid path and then if it is proceed otherwise throw.
// // };
