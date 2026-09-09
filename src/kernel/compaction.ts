import type { CompactionCheckInfo, CompactionContext, CompactionResult, CompactionStrategy } from '@openharness/core'
import type { ModelMessage } from 'ai'
import { generateText } from 'ai'

/**
 * ── Folding the past without losing the present ──────────────────────────────
 *
 * The library's DefaultCompactionStrategy protects the recent tail only in its
 * PRUNING phase; when pruning does not save enough it falls through to
 * summarization, and that phase replaces the ENTIRE conversation with one
 * summary message. At the context cliff — the one place auto-compaction fires —
 * that would trade the model's working memory of the last few minutes for a
 * paragraph, mid-task. The timeline spec caught it on the manual path first:
 * compact a short session and the model forgot a word from two turns ago.
 *
 * This strategy folds only the OLD: everything before the protected tail is
 * summarized, the tail itself survives verbatim, and a conversation that fits
 * inside the tail has nothing to fold at all — which is an honest no-op, not a
 * failure.
 *
 * The tail is the newer HALF of the conversation. So a fold that fires with the
 * window around nine-tenths full lands near a quarter full, and the session has
 * the same room to work as it had at the start — rather than reclaiming almost
 * everything once and then folding again a few turns later.
 *
 **/

/** How much of the conversation survives verbatim: the newer HALF.
 *
 *  Proportional, not a fixed number of tokens. A fixed tail answered the same
 *  way for a 200k window and a 1M one — it kept 20k either way, which is most of
 *  a small window and a rounding error in a large one. Halving instead means the
 *  fold always does the same amount of good: fire at the threshold, come out at
 *  roughly a quarter of the window, and have the same room to work again. */
const KEPT_FRACTION = 0.5

/** The library's own estimator: crude, and only ever used to find a boundary,
 *  not to bill anybody. */
function estimate(messages: ModelMessage[]): number {
  return JSON.stringify(messages).length / 4
}

const SUMMARY_PROMPT = `You summarize an agent conversation so it can continue with less history.
Preserve: what the user is trying to achieve, decisions made, facts and names mentioned, file paths touched, and anything the user asked to remember.
Write a dense factual summary. No preamble, no commentary.`

export function tailPreservingCompaction(): CompactionStrategy {
  return {
    async compact(context: CompactionContext): Promise<CompactionResult> {
      const messages = context.messages

      /**
       *
       * Walk back from the end until the tail budget is spent. The newest
       * message is always kept, however large — a tail of nothing would make
       * the fold indistinguishable from amnesia.
       *
       **/
      const budget = estimate(messages) * KEPT_FRACTION
      let tailStart = messages.length
      let kept = 0
      while (tailStart > 0) {
        const next = estimate([messages[tailStart - 1]!])
        if (kept + next > budget && tailStart !== messages.length) break
        kept += next
        tailStart--
      }
      /**
       *
       * Never split a tool exchange: a tool result whose call was summarized
       * away is an invalid conversation to every provider. Pull the call into
       * the tail instead.
       *
       **/
      while (tailStart > 0 && messages[tailStart]?.role === 'tool') tailStart--

      const head = messages.slice(0, tailStart)
      const tail = messages.slice(tailStart)
      if (head.length === 0) {
        return { messages, messagesRemoved: 0, tokensPruned: 0 }
      }

      const conversationText = head.map((m) => `${m.role}: ${JSON.stringify(m.content)}`).join('\n')
      const { text: summary } = await generateText({
        model: context.model,
        system: context.compactionPrompt ?? SUMMARY_PROMPT,
        messages: [{ role: 'user', content: conversationText }],
        ...(context.signal ? { abortSignal: context.signal } : {}),
      })

      const folded: ModelMessage[] = [
        {
          role: 'user',
          content: `[Previous conversation summary]\n\n${summary}\n\n[The conversation continues from here]`,
        },
        ...tail,
      ]
      return {
        messages: folded,
        summary,
        messagesRemoved: head.length - 1,
        tokensPruned: Math.max(0, estimate(head) - estimate([folded[0]!])),
      }
    },
  }
}

/** Is this conversation about to outgrow the model's window?
 *
 *  The library's own check reads `lastInputTokens`, which it fills in from the
 *  events of turns it has already run. That works for a Session that stays
 *  alive across turns; ours does not, because the agent definition is re-read
 *  on every turn so that editing an agent takes effect on the next one. A fresh
 *  Session starts that counter at zero, so the built-in check would answer "no"
 *  every single time and auto-compaction would never fire at all.
 *
 *  So the size is measured from the conversation itself, which is on hand and
 *  needs no memory of earlier turns. The estimator is the library's own
 *  (JSON length / 4) — crude, and it only has to be right about approaching a
 *  cliff, not about the exact distance to it. The measured figure still wins
 *  whenever there is one. */
export function overflowing(info: CompactionCheckInfo): boolean {
  const estimated = JSON.stringify(info.messages).length / 4
  return Math.max(info.lastInputTokens, estimated) >= compactionThreshold(info.contextWindow)
}

/** When a conversation is folded: the lower of nine-tenths of the window and
 *  450k tokens.
 *
 *  Two limits because they answer different problems. The FRACTION is about the
 *  cliff: a turn needs room for its own answer, and a conversation that fills
 *  the window leaves none. Waiting for the actual edge, as this used to, meant
 *  the fold fired only once the next turn was already doomed.
 *
 *  The CEILING is about cost and latency, which the fraction ignores entirely.
 *  Nine-tenths of a million-token window is 900k tokens re-sent on every single
 *  turn — priced per turn, and slow, long before anything overflows. Past a
 *  point a bigger window stops being a reason to carry more history and starts
 *  being a bill. */
export function compactionThreshold(contextWindow: number): number {
  return Math.min(contextWindow * 0.9, 450_000)
}
