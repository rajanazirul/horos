import Image from "next/image";
import { EarlyAccessForm } from "./EarlyAccessForm";
import { Mark } from "./Header";
import { EVENT, GITHUB_URL } from "@/lib/site";

export function FinalCta() {
  return (
    <section
      id="early-access"
      aria-labelledby="cta-title"
      className="relative isolate overflow-hidden border-t border-line"
    >
      <Image
        src="/images/inscription.webp"
        alt=""
        fill
        sizes="100vw"
        className="-z-10 object-cover opacity-20 [[data-theme=light]_&]:opacity-[0.08] [[data-theme=light]_&]:mix-blend-multiply"
      />
      <div
        aria-hidden="true"
        className="absolute inset-0 -z-10 bg-gradient-to-b from-bg via-bg/60 to-bg"
      />
      <div className="relative mx-auto grid max-w-6xl gap-12 px-4 py-20 sm:px-6 lg:grid-cols-[0.9fr_1.1fr] lg:py-28">
        <div>
          <h2
            id="cta-title"
            className="font-display text-4xl font-medium leading-[1.08] tracking-[-0.02em] sm:text-5xl"
          >
            Get Horos integrated into your agent, free during Tameion.
          </h2>
          <p className="mt-6 max-w-md text-lg leading-8 text-muted">
            Building a payment agent for the {EVENT.name} ({EVENT.dates})? Tell us what it does.
            We&apos;ll help you add Horos to it, one on one, at no cost.
          </p>
          <p className="mt-6 text-sm leading-6 text-muted">
            Prefer to read the code first?{" "}
            {/* TODO(founder): GITHUB_URL is a "#" placeholder until the repo is public. */}
            <a href={GITHUB_URL} className="text-ink underline underline-offset-4 hover:text-accent">
              View Horos on GitHub
            </a>
            .
          </p>
        </div>
        <div className="rounded-md border border-line bg-surface p-5 sm:p-8">
          <EarlyAccessForm />
        </div>
      </div>
    </section>
  );
}

export function Footer() {
  return (
    <footer className="border-t border-line bg-surface">
      <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
        <div className="grid gap-10 md:grid-cols-[1fr_1.3fr]">
          <div>
            <div className="flex items-center gap-2.5 text-ink">
              <Mark className="h-7 w-5" />
              <span className="font-display text-xl font-medium">Horos</span>
            </div>
            <figure className="mt-6 max-w-sm">
              <blockquote lang="grc" className="font-display text-lg tracking-[0.12em] text-ink">
                ΗΟΡΟΣ ΕΙΜΙ ΤΕΣ ΑΓΟΡΑΣ
              </blockquote>
              <figcaption className="mt-2 text-sm leading-6 text-muted">
                &ldquo;I am the boundary of the Agora.&rdquo; Athens, about 500 BCE. A horos stone
                marked a limit, and on mortgaged land, the debt the land was pledged against.
              </figcaption>
            </figure>
          </div>
          <div className="space-y-4 text-sm leading-6 text-muted">
            <p>
              <strong className="font-medium text-ink">Horos is a policy-enforcement and evidence tool.</strong>{" "}
              It enforces the policy you choose and records why each decision was made. It is not
              legal or compliance advice and does not make you compliant. You remain responsible
              for your own compliance decisions.
            </p>
            <p>
              <strong className="font-medium text-ink">Non-custodial.</strong> Payments are made
              from your wallet with your keys. Horos never holds or moves your funds.
            </p>
            <p>
              Early access software running on Arc testnet. Arc, Circle, USDC, OFAC, Jev and
              TypeSafe AI are named only to describe what Horos works with. No partnership,
              sponsorship or endorsement is implied.
            </p>
          </div>
        </div>
        <div className="limit-line mt-12" aria-hidden="true" />
        <div className="mt-6 flex flex-col gap-3 text-sm text-muted sm:flex-row sm:items-center sm:justify-between">
          <p>&copy; 2026 Horos</p>
          <ul className="flex flex-wrap gap-x-6 gap-y-2">
            <li>
              <a href="#how-it-works" className="hover:text-ink">
                How it works
              </a>
            </li>
            <li>
              <a href="#pricing" className="hover:text-ink">
                Pricing
              </a>
            </li>
            <li>
              <a href={GITHUB_URL} className="hover:text-ink">
                GitHub
              </a>
            </li>
          </ul>
        </div>
      </div>
    </footer>
  );
}
