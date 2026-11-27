const { readFileSync } = require("node:fs");
const vm = require("node:vm");
const { parse } = require(process.env.SYNCTV_ACORN);

const source = readFileSync(process.env.SYNCTV_PLAYER_JS, "utf8");
const rust = readFileSync("synctv-media-providers/src/youtube/challenge.rs", "utf8");
const [initializer, wrapper] = parse(source, { ecmaVersion: "latest" }).body;
const player = wrapper.expression;
const body = player.callee.body;
const text = (node) => source.slice(node.start, node.end);
const marker = /["']alr["']\s*,\s*["']yes["']/;
const candidates = [];
for (const statement of body.body) {
  const getTarget = (value, name) => {
    if (value?.type === "FunctionExpression" && marker.test(text(value.body))) {
      candidates.push(text(name));
    }
  };
  if (statement.type === "VariableDeclaration") {
    for (const declaration of statement.declarations) getTarget(declaration.init, declaration.id);
  } else if (statement.type === "FunctionDeclaration" && marker.test(text(statement.body))) {
    candidates.push(text(statement.id));
  } else if (statement.expression?.type === "AssignmentExpression") {
    getTarget(statement.expression.right, statement.expression.left);
  }
}
console.log("transformers:", [...new Set(candidates)].sort().join(", "));
const setup = rust.match(/const SETUP_SOURCE: &str = r#"([\s\S]+?)"#;/)[1];
const solver = rust.match(/const SOLVER_SOURCE: &str = r#"([\s\S]+?)"#;/)[1];
const kept = new Set(["AssignmentExpression", "Literal", "TemplateLiteral"]);
function check(label, keepCall, skipNew) {
  const inner = body.body.flatMap((statement) => {
    if (statement.type === "ExpressionStatement") {
      const item = statement.expression;
      return kept.has(item.type) || (item.type === "CallExpression" && keepCall(text(item.callee))) ? [text(statement)] : [];
    }
    if (skipNew && statement.type === "VariableDeclaration") {
      const pieces = statement.declarations.map((item) => {
        return item.init?.type === "NewExpression" ? text(item.id) : text(item);
      });
      return [statement.kind + " " + pieces.join(",") + ";"];
    }
    return [text(statement)];
  });
  const program = [
    setup, text(initializer),
    "const __synctv_run_player = " + source.slice(player.start, body.start) + "{",
    ...inner,
    "const __synctv_transformers=[" + [...new Set(candidates)].sort().join(",") + "];",
    solver, "return __synctv_solve;",
    "}" + source.slice(body.end, player.end) + ";",
    "__synctv_run_player('n','abcd1234EFGH5678');",
  ].join("\n");
  try {
    const output = vm.runInNewContext(program, {}, { timeout: 12000, filename: "prepared.js" });
    console.log(label, "resolved:", typeof output, output.length, output !== "abcd1234EFGH5678");
  } catch (err) {
    const stack = String(err.stack);
    console.log(label, String(err));
    for (const frame of [...new Set([...stack.matchAll(/prepared\.js:(\d+)/g)].map((m) => Number(m[1])))].slice(0, 5)) {
      console.log("line", frame, program.split("\n")[frame - 1]?.slice(0, 200));
    }
  }
}
check("filtered", () => false, false);
check("inheritance setup retained", (name) => name === "g.z", false);
check("inheritance with unused constructors skipped", (name) => name === "g.z", true);
