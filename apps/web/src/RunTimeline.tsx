import type { RunTimelineItem } from "./types";

function formatTimelineTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

function outcomeLabel(event: RunTimelineItem): string {
  if (event.outcome === "succeeded") return "Completed";
  if (event.outcome === "pending") return "In progress";
  return event.outcome[0]!.toUpperCase() + event.outcome.slice(1);
}

export function RunTimeline({ events }: { events: RunTimelineItem[] }) {
  if (events.length === 0) return null;

  return (
    <section className="run-timeline" aria-labelledby="run-timeline-title" aria-live="polite">
      <header className="run-timeline-heading">
        <div>
          <span className="eyebrow">Persistent run record</span>
          <h3 id="run-timeline-title">What happened</h3>
        </div>
        <span className="run-timeline-count">{events.length} {events.length === 1 ? "event" : "events"}</span>
      </header>
      <ol className="run-timeline-list">
        {events.map((event) => (
          <li className={`run-timeline-event run-timeline-event-${event.outcome}`} key={event.id}>
            <span className="run-timeline-sequence" aria-label={`Event ${event.sequence}`}>
              {event.sequence}
            </span>
            <div className="run-timeline-copy">
              <div className="run-timeline-meta">
                <strong>{outcomeLabel(event)}</strong>
                <time dateTime={event.occurredAt}>{formatTimelineTime(event.occurredAt)}</time>
              </div>
              <p>{event.summary}</p>
              {event.delegation && (
                <span className="run-timeline-delegation">
                  Delegated from {event.delegation.parentAgentId} to {event.delegation.childAgentId}
                </span>
              )}
              <details>
                <summary>Technical details</summary>
                <dl>
                  <div><dt>Event</dt><dd>{event.type}</dd></div>
                  <div><dt>Reason</dt><dd>{event.reasonCode}</dd></div>
                  {event.resource && <div><dt>Resource</dt><dd>{event.resource.resourceId}</dd></div>}
                  {event.decision && <div><dt>Decision</dt><dd>{event.decision.result}</dd></div>}
                  <div><dt>Event ID</dt><dd>{event.id}</dd></div>
                </dl>
              </details>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
