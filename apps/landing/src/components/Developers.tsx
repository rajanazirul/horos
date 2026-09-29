import { Code } from "./Code";
import { MCP_PACKAGE, SDK_PACKAGE } from "@/lib/site";
import { Reveal } from "./Reveal";

const PROMPT = `> add Horos to my agent so it checks every counterparty before paying`;

const MCP = `# or wire the MCP server in yourself
claude mcp add horos -- npx -y ${MCP_PACKAGE}`;

const SDK = `npm install ${SDK_PACKAGE}`;

const USAGE = `const d = await horos.check(invoice.payTo, invoice.amount);

switch (d.decision) {
  case "allow":
  case "cap":
    // the contract already enforces d.limit on-chain
    await wallet.pay(invoice.payTo, min(invoice.amount, d.limit));
    break;
  case "hold":
    await notifyOwner(invoice, d.reason, d.evidenceId);
    break;
  case "block":
    await rejectInvoice(invoice, d.reason);
}`;

type Cell = "allow" | "cap" | "hold" | "block";
const POLICY_ROWS: { situation: string; values: [Cell, Cell, Cell] }[] = [
  { situation: "Exact sanctions match", values: ["block", "block", "block"] },
  { situation: "New counterparty, no history", values: ["hold", "cap", "allow"] },
  { situation: "Graded medium risk", values: ["hold", "cap", "cap"] },
  { situation: "Graded high risk", values: ["hold", "hold", "hold"] },
  { situation: "Model not confident", values: ["hold", "hold", "cap"] },
];

const cellColor: Record<Cell, string> = {
  allow: "text-allow",
  cap: "text-cap",
  hold: "text-hold",
  block: "text-block",
};

export function Developers() {
  return (
    <section id="developers" aria-labelledby="dev-title" className="border-t border-line bg-surface/40">
      <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6 lg:py-24">
        <Reveal className="max-w-2xl">
          <h2
            id="dev-title"
            className="font-display text-3xl font-medium leading-tight tracking-[-0.01em] sm:text-4xl"
          >
            Add it with one prompt, or a few lines of TypeScript.
          </h2>
          <p className="mt-5 text-lg leading-8 text-muted">
            Horos is for developers building agents that move money: invoice and AP agents,
            escrow and contractor payouts, autonomous business operators, x402 sellers. It&apos;s
            a feature you ship to your customers, not another dashboard for them to watch.
          </p>
        </Reveal>

        <Reveal delay={100} className="mt-12 grid gap-10 lg:grid-cols-2 lg:gap-12">
          <div>
            <h3 className="text-lg font-medium text-ink">From Claude Code</h3>
            <p className="mt-2 leading-7 text-muted">
              The Horos skill and MCP server give your coding agent the docs and tools it needs to
              do the integration for you.
            </p>
            <Code className="mt-5" lang="text" title="claude" label="Claude Code prompt" code={PROMPT} />
            <Code className="mt-3" lang="sh" title="terminal" label="MCP setup command" code={MCP} />
          </div>
          <div>
            <h3 className="text-lg font-medium text-ink">From the SDK</h3>
            <p className="mt-2 leading-7 text-muted">
              One check before each payment. Your code keeps control of what happens next.
            </p>
            <Code className="mt-5" lang="sh" title="terminal" label="SDK install command" code={SDK} />
            <Code className="mt-3" title="pay.ts" label="Handling each Horos decision" code={USAGE} />
          </div>
        </Reveal>

        <div className="mt-16">
          <h3 className="text-lg font-medium text-ink">Sensible defaults, so it works with no setup</h3>
          <p className="mt-2 max-w-2xl leading-7 text-muted">
            Pick a starting policy for your customers and adjust any row. Graded risk defaults to
            cap or hold rather than block, so a borderline call slows a payment down instead of
            losing you a supplier.
          </p>
          <div className="mt-6 overflow-x-auto rounded-md border border-line">
            <table className="w-full min-w-[34rem] border-collapse text-left text-sm">
              <caption className="sr-only">Decision by situation for each default policy</caption>
              <thead className="bg-surface">
                <tr>
                  <th scope="col" className="px-4 py-3 font-medium text-muted">
                    Situation
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium text-ink">
                    Conservative
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium text-ink">
                    Standard
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium text-ink">
                    Permissive
                  </th>
                </tr>
              </thead>
              <tbody>
                {POLICY_ROWS.map((r) => (
                  <tr key={r.situation} className="border-t border-line">
                    <th scope="row" className="px-4 py-3 font-normal text-ink">
                      {r.situation}
                    </th>
                    {r.values.map((v, i) => (
                      <td key={i} className={`px-4 py-3 font-mono ${cellColor[v]}`}>
                        {v}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-xs leading-5 text-muted">
            Defaults may change during early access. Coming soon: an x402 endpoint, so an agent can
            pay per check with no account at all.
          </p>
        </div>
      </div>
    </section>
  );
}
