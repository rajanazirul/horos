import { Code } from "./Code";
import { InvariantDemo } from "./InvariantDemo";
import { Reveal } from "./Reveal";
import { RolesDiagram } from "./RolesDiagram";

const CONTRACT = `// Illustrative. The policy contract will be open source.
function tighten(address cp, uint256 next) external onlyRole(MODEL) {
    require(next <= limitOf[cp], "only-tighten");
    limitOf[cp] = next;
}

function raise(address cp, uint256 next) external onlyRole(HUMAN) {
    require(!hardBlocked[cp], "hard rule");
    limitOf[cp] = next;
}`;

const ROLES = [
  {
    role: "Hard rules",
    can: "Set the ceiling",
    detail: "Sanctions matches and your caps. Code, not a model.",
  },
  {
    role: "The model",
    can: "Lower the limit, never raise it",
    detail: "Grades below the ceiling. A wrong answer can over-block, never under-block.",
  },
  {
    role: "A person",
    can: "Raise a limit",
    detail: "The only way up. Signed and recorded.",
  },
];

export function Invariant() {
  return (
    <section id="invariant" aria-labelledby="invariant-title" className="border-t border-line bg-surface/40">
      <div className="mx-auto grid max-w-6xl gap-14 px-4 py-20 sm:px-6 lg:grid-cols-[0.95fr_1.05fr] lg:py-24">
        <div>
          <Reveal>
            <h2
              id="invariant-title"
              className="font-display text-3xl font-medium leading-tight tracking-[-0.01em] sm:text-5xl"
            >
              The model can only tighten.
            </h2>
            <p className="mt-5 max-w-lg text-lg leading-8 text-muted">
              Models are wrong sometimes. Horos is built so that when the model is wrong, your
              agent pays less, not more. The rule lives in the contract&apos;s roles, so no prompt,
              injected or otherwise, can change it.
            </p>
          </Reveal>

          <dl className="mt-10 border-t border-line">
            {ROLES.map((r) => (
              <div
                key={r.role}
                className="grid gap-1 border-b border-line py-4 sm:grid-cols-[8rem_1fr] sm:gap-6"
              >
                <dt className="text-sm text-muted">{r.role}</dt>
                <dd>
                  <span className="text-ink">{r.can}</span>
                  <span className="mt-1 block text-sm leading-6 text-muted">{r.detail}</span>
                </dd>
              </div>
            ))}
          </dl>

          <RolesDiagram className="mt-10" />

          <Reveal className="mt-10">
            <Code
              lang="sol"
              title="PolicyWallet.sol (excerpt)"
              label="Illustrative Solidity excerpt showing the only-tighten rule"
              code={CONTRACT}
            />
          </Reveal>
        </div>

        <div className="lg:sticky lg:top-24 lg:self-start lg:pt-3">
          <Reveal delay={120}>
            <InvariantDemo />
          </Reveal>
        </div>
      </div>
    </section>
  );
}
