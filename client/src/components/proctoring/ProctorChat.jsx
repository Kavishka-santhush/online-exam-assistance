import { useEffect, useRef, useState } from 'react';
import { Send } from 'lucide-react';
import { request, endpoints } from '@/lib/apiClient';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';

/**
 * Proctor → candidate message thread.
 *
 * Pulls the persisted history from `GET /proctoring/:attempt/messages` and posts
 * new lines (warnings or replies) to the reply endpoint; the server fans the
 * message out to the candidate's `proctor:message` socket event. The proctor's
 * own outgoing messages are echoed locally so the thread updates instantly
 * without waiting for a round-trip render.
 */
export function ProctorChat({ attemptId, title = 'Candidate chat' }) {
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(false);
  const bottomRef = useRef(null);

  useEffect(() => {
    if (!attemptId) return undefined;
    let alive = true;
    setLoading(true);
    request
      .get(endpoints.proctoring.messages(attemptId))
      .then((data) => {
        if (alive) setMessages(Array.isArray(data) ? data : data?.items ?? []);
      })
      .catch(() => {})
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [attemptId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  async function send(kind = 'REPLY') {
    const body = text.trim();
    if (!body) return;
    setText('');
    const optimistic = { id: `local-${Date.now()}`, body, kind, direction: 'from-proctor', createdAt: new Date().toISOString() };
    setMessages((prev) => [...prev, optimistic]);
    try {
      await request.post(endpoints.proctoring.reply(attemptId), { body, kind });
    } catch {
      /* leave optimistic; a reload reconciles */
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="border-b px-3 py-2 text-sm font-medium">{title}</div>
      <ScrollArea className="flex-1 p-3">
        {loading && messages.length === 0 ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
        <div className="space-y-2">
          {messages.map((message) => {
            const mine = (message.direction ?? 'from-proctor') === 'from-proctor';
            return (
              <div key={message.id} className={cn('flex', mine ? 'justify-end' : 'justify-start')}>
                <div className={cn('max-w-[85%] rounded-lg px-3 py-1.5 text-sm', mine ? 'bg-primary text-primary-foreground' : 'bg-muted', message.kind === 'WARNING' && 'bg-destructive text-destructive-foreground')}>
                  {message.body}
                </div>
              </div>
            );
          })}
        </div>
        <div ref={bottomRef} />
      </ScrollArea>
      <div className="flex gap-2 border-t p-2">
        <Input value={text} onChange={(event) => setText(event.target.value)} onKeyDown={(event) => event.key === 'Enter' && send()} placeholder="Message candidate…" />
        <Button size="icon" onClick={() => send()} aria-label="Send"><Send className="h-4 w-4" /></Button>
      </div>
    </div>
  );
}

export default ProctorChat;
