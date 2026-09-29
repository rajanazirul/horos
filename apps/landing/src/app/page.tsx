import { ContinuousWatch } from "@/components/ContinuousWatch";
import { Developers } from "@/components/Developers";
import { Faq } from "@/components/Faq";
import { FinalCta, Footer } from "@/components/Closing";
import { Header } from "@/components/Header";
import { Hero } from "@/components/Hero";
import { HowItWorks } from "@/components/HowItWorks";
import { Invariant } from "@/components/Invariant";
import { Pricing } from "@/components/Pricing";
import { Problem } from "@/components/Problem";
import { UseCases } from "@/components/UseCases";

export default function Home() {
  return (
    <>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-accent focus:px-4 focus:py-2 focus:text-accent-ink"
      >
        Skip to content
      </a>
      <Header />
      <main id="main">
        <Hero />
        <Problem />
        <HowItWorks />
        <Invariant />
        <ContinuousWatch />
        <UseCases />
        <Developers />
        <Pricing />
        <Faq />
        <FinalCta />
      </main>
      <Footer />
    </>
  );
}
