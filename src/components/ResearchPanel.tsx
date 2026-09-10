"use client";

import { useState } from "react";
import { BuybackResearchPanel } from "@/components/BuybackResearchPanel";
import { ConcallResearchPanel } from "@/components/ConcallResearchPanel";
import { OrderbookResearchPanel } from "@/components/OrderbookResearchPanel";

function ResearchSection({
  id,
  title,
  defaultOpen,
  children,
}: {
  id: string;
  title: string;
  defaultOpen: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section
      className={open ? "research-block" : "research-block collapsed"}
      id={id}
    >
      <button
        type="button"
        className="research-block-toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="research-block-title">{title}</span>
        <span className="research-block-chevron" aria-hidden>
          {open ? "▾" : "▸"}
        </span>
        <span className="research-block-hint">
          {open ? "Minimise" : "Expand"}
        </span>
      </button>
      {/* Keep mounted when minimised so Find latest / Analyze / Run keep going */}
      <div
        className="research-block-body"
        hidden={!open}
        inert={!open ? true : undefined}
      >
        {children}
      </div>
    </section>
  );
}

export function ResearchPanel() {
  return (
    <div className="research-page">
      <ResearchSection
        id="research-buyback"
        title="1 · Buyback"
        defaultOpen={false}
      >
        <BuybackResearchPanel />
      </ResearchSection>
      <ResearchSection
        id="research-orderbook"
        title="2 · Order book"
        defaultOpen={false}
      >
        <OrderbookResearchPanel />
      </ResearchSection>
      <ResearchSection
        id="research-concall"
        title="3 · Concall"
        defaultOpen
      >
        <ConcallResearchPanel />
      </ResearchSection>
    </div>
  );
}
