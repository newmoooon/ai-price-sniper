"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { ArrowUp, Crosshair, ExternalLink, MessageCircle, Store, X } from "lucide-react";

import { askAssistant } from "@/app/actions";
import type { AssistantSource, ChatMessage } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * "Ask Sniper" — a floating chat assistant grounded in the user's live
 * dashboard (the server action injects their products + price history as
 * context on every question).
 *
 * UI follows current chat-widget conventions: launcher button, slide-up
 * panel, suggested prompts on the empty state (users freeze at a blank
 * input), typing indicator while Gemini thinks, user/assistant bubbles.
 */

const SUGGESTED_PROMPTS = [
  "Which product is closest to my target?",
  "Should I buy now or wait?",
  "Find my products cheaper at other stores",
];

/**
 * Lets any component hand the assistant a question (e.g. the "find it
 * cheaper elsewhere" button on a product panel): opens the panel and asks.
 */
export function askSniper(question: string) {
  window.dispatchEvent(new CustomEvent("sniper:ask", { detail: question }));
}

export function Assistant() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isPending, startTransition] = useTransition();
  const scrollRef = useRef<HTMLDivElement>(null);

  // Keep the newest message in view as the conversation grows.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, isPending, open]);

  function send(text: string) {
    const question = text.trim();
    if (!question || isPending) return;
    const next: ChatMessage[] = [...messages, { role: "user", content: question }];
    setMessages(next);
    setInput("");
    startTransition(async () => {
      // Only role + content cross the wire — source cards are render state.
      const result = await askAssistant(next.map(({ role, content }) => ({ role, content })));
      setMessages((prev) => [
        ...prev,
        result.ok
          ? { role: "assistant", content: result.data.reply, sources: result.data.sources }
          : { role: "assistant", content: result.error },
      ]);
    });
  }

  // `send` closes over current state; keep a live ref so the global
  // askSniper() event always reaches the latest version.
  const sendRef = useRef(send);
  sendRef.current = send;
  useEffect(() => {
    function onAsk(e: Event) {
      setOpen(true);
      sendRef.current((e as CustomEvent<string>).detail);
    }
    window.addEventListener("sniper:ask", onAsk);
    return () => window.removeEventListener("sniper:ask", onAsk);
  }, []);

  return (
    <>
      {/* ── Launcher ─────────────────────────────────────────────────── */}
      <Button
        onClick={() => setOpen((o) => !o)}
        aria-label={open ? "Close assistant" : "Ask Sniper, your deal assistant"}
        className="fixed bottom-5 right-5 z-40 h-12 w-12 rounded-full shadow-lg shadow-primary/25 transition-transform hover:scale-105"
      >
        {open ? <X className="size-5" aria-hidden /> : <MessageCircle className="size-5" aria-hidden />}
      </Button>

      {/* ── Panel ────────────────────────────────────────────────────── */}
      {open && (
        <div
          role="dialog"
          aria-label="Sniper assistant chat"
          className="drawer-in fixed bottom-20 right-5 z-40 flex h-[min(560px,calc(100dvh-7rem))] w-[min(380px,calc(100vw-2.5rem))] flex-col overflow-hidden rounded-2xl border bg-card shadow-2xl"
        >
          {/* Header */}
          <div className="flex items-center gap-2.5 border-b px-4 py-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <Crosshair className="h-4 w-4" aria-hidden />
            </div>
            <div>
              <p className="font-heading text-sm font-semibold leading-tight">Ask Sniper</p>
              <p className="text-xs text-muted-foreground">Knows your deals · searches the web</p>
            </div>
          </div>

          {/* Messages */}
          <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto p-4">
            {messages.length === 0 && (
              <div className="space-y-3">
                <div className="max-w-[85%] rounded-2xl rounded-tl-md bg-muted px-3.5 py-2.5 text-sm">
                  Hey! I can see your tracked products and their price history, and I can search
                  the web to find them at other stores. What would you like to know?
                </div>
                <div className="flex flex-wrap gap-2">
                  {SUGGESTED_PROMPTS.map((prompt) => (
                    <button
                      key={prompt}
                      type="button"
                      onClick={() => send(prompt)}
                      className="rounded-full border bg-background px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
                    >
                      {prompt}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((message, i) => (
              <div key={i} className={cn("space-y-2", message.role === "user" && "flex justify-end")}>
                <div
                  className={cn(
                    "max-w-[85%] whitespace-pre-wrap rounded-2xl px-3.5 py-2.5 text-sm",
                    message.role === "user"
                      ? "rounded-tr-md bg-primary text-primary-foreground"
                      : "rounded-tl-md bg-muted"
                  )}
                >
                  {message.content}
                </div>
                {message.sources && message.sources.length > 0 && (
                  <SourceCards sources={message.sources} />
                )}
              </div>
            ))}

            {/* Typing indicator */}
            {isPending && (
              <div className="flex w-fit items-center gap-1 rounded-2xl rounded-tl-md bg-muted px-3.5 py-3" aria-label="Assistant is thinking">
                <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground/70 [animation-delay:0ms]" />
                <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground/70 [animation-delay:120ms]" />
                <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground/70 [animation-delay:240ms]" />
              </div>
            )}
          </div>

          {/* Input */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              send(input);
            }}
            className="flex items-center gap-2 border-t p-3"
          >
            <Input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask about your deals…"
              disabled={isPending}
              maxLength={2000}
              aria-label="Message the assistant"
              className="h-9"
            />
            <Button
              type="submit"
              size="icon"
              disabled={isPending || !input.trim()}
              aria-label="Send message"
              className="shrink-0 rounded-full"
            >
              <ArrowUp className="size-4" aria-hidden />
            </Button>
          </form>
        </div>
      )}
    </>
  );
}

/**
 * Tappable store cards under a web-grounded answer — where the assistant
 * actually found the item. Links open through Google's grounding redirect
 * (that's what the API returns), in a new tab.
 */
function SourceCards({ sources }: { sources: AssistantSource[] }) {
  return (
    <div className="max-w-[85%] space-y-1.5">
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        Found at
      </p>
      {sources.map((source) => (
        <a
          key={source.url}
          href={source.url}
          target="_blank"
          rel="noopener noreferrer"
          className="group flex items-center gap-2.5 rounded-xl border bg-background px-3 py-2 transition-colors hover:border-primary/40 hover:bg-muted/50"
        >
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
            <Store className="h-3.5 w-3.5" aria-hidden />
          </span>
          <span className="min-w-0 flex-1 truncate text-xs font-medium">{source.title}</span>
          <ExternalLink
            className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground"
            aria-hidden
          />
        </a>
      ))}
    </div>
  );
}
