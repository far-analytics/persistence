import { Client, RWDependencyGraph } from "persistence";

const g = new RWDependencyGraph();
const p = new Client({ rwDependencyGraph: g });

const data = await p.readFile("/home/null/workspace/repos/adpatter/persistence/tests/test/data.json");

console.log(data);
