import Image from "next/image";
import { Code } from "./Code";
import { HeroFlow } from "./HeroFlow";
import { Reveal } from "./Reveal";
import { EVENT, GITHUB_URL, SDK_PACKAGE } from "@/lib/site";

const CALL = `import { Horos } from "${SDK_PACKAGE}";

const horos = new Horos({ policy: "standard" });

// Before your agent sends USDC to anyone:
const d = await horos.check(vendor.wallet, "1200.00");`;

const RESULT = `{
  "decision": "cap",
  "limit": "500.00",
  "reason": "Name is a close match to a listed entity",
  "confidence": 0.91,
  "hardRules": { "ofacExactMatch": false },
  "onchainLimit": { "chain": "arc-testnet", "tx": "0x8c1f…e27a" },
  "evidenceId": "ev_01J9Q…4TX"
}`;

export function Hero() {
  return (
    <section id="top" aria-labelledby="hero-title" className="relative isolate overflow-hidden">
      <Image
        src="/images/hero-stone.webp"
        alt=""
        fill
        preload
        sizes="100vw"
        className="-z-10 object-cover object-[50%_35%] opacity-40 [[data-theme=light]_&]:opacity-[0.07] [[data-theme=light]_&]:mix-blend-multiply"
      />
      <div
        aria-hidden="true"
        className="absolute inset-0 -z-10 bg-gradient-to-b from-bg/60 via-bg/70 to-bg"
      />
      <div className="mx-auto grid max-w-6xl gap-12 px-4 pb-20 pt-14 sm:px-6 md:pt-20 lg:grid-cols-[1.05fr_1fr] lg:gap-14 lg:pb-16">
        <Reveal className="max-w-xl">
          <p className="mb-8 inline-flex items-start gap-2 rounded-md border border-line px-3 py-1 text-xs leading-5 text-muted">
            <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-cap" aria-hidden="true" />
            <span>
              Early access. Built on Arc testnet during the {EVENT.name}, {EVENT.dates}.
            </span>
          </p>
          <h1
            id="hero-title"
            className="font-display text-[2.5rem] font-medium leading-[1.05] tracking-[-0.02em] text-ink sm:text-6xl"
          >
            Your agent pays without asking you. It never pays past the line.
          </h1>
          <p className="mt-6 max-w-[34rem] text-lg leading-8 text-muted">
            Horos checks a counterparty before your AI agent sends USDC and answers allow, cap,
            hold or block, with a reason and a calibrated confidence. Then it writes that
            counterparty&apos;s limit to a smart contract on Arc. A prompt-injected agent still
            can&apos;t spend past it.
          </p>
          <div className="mt-9 flex flex-col gap-3 sm:flex-row sm:items-center">
            <a
              href="#early-access"
              className="inline-flex h-12 items-center justify-center rounded-md bg-accent px-6 text-base font-medium text-accent-ink transition-opacity hover:opacity-90"
            >
              Get Horos integrated, free
            </a>
            {/* TODO(founder): GITHUB_URL is a "#" placeholder until the repo is public. */}
            <a
              href={GITHUB_URL}
              className="inline-flex h-12 items-center justify-center gap-2 rounded-md border border-line-strong px-6 text-base text-ink transition-colors hover:bg-surface"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" fill="currentColor">
                <path d="M8 0a8 8 0 0 0-2.53 15.59c.4.07.55-.17.55-.38v-1.33c-2.23.48-2.7-1.07-2.7-1.07-.36-.92-.89-1.17-.89-1.17-.73-.5.05-.49.05-.49.8.06 1.23.83 1.23.83.72 1.23 1.88.87 2.34.67.07-.52.28-.87.5-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.28.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48v2.2c0 .21.15.46.55.38A8 8 0 0 0 8 0Z" />
              </svg>
              View on GitHub
            </a>
          </div>
          <p className="mt-4 text-sm text-muted">
            Free during Tameion, with hands-on help adding it to your agent.
          </p>
        </Reveal>

        <Reveal className="relative lg:pt-2" delay={120}>
          <Code
            label="Example: calling horos.check before a payment"
            title="agent.ts"
            code={CALL}
          />
          <div className="relative mx-6 flex items-center gap-3 py-3 text-xs text-muted" aria-hidden="true">
            <span className="h-6 w-px bg-line-strong" />
            <span>returns in one call</span>
          </div>
          <Code label="Example response from horos.check" title="response" lang="json" code={RESULT} />
          <p className="mt-3 text-xs leading-5 text-muted">
            Illustrative response. The limit is now enforced by the contract, not by the
            agent&apos;s prompt.
          </p>
        </Reveal>
      </div>

      <div className="mx-auto max-w-6xl px-4 pb-20 sm:px-6 lg:pb-24">
        <div className="limit-line" aria-hidden="true" />
        <figure className="pt-8">
          <HeroFlow />
          <figcaption className="mt-4 text-xs leading-5 text-muted">
            Illustrative flow. One counterparty, example amounts: the limit steps down on-chain and
            the next payment is capped.
          </figcaption>
        </figure>
      </div>
    </section>
  );
}
