import { GraphNode } from "./graph_node.js";

export interface Artifact {
  locks: Promise<unknown>[];
  ancestors: GraphNode[];
  node: GraphNode;
}