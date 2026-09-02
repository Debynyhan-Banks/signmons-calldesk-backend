"use client";

import { useEffect, useState } from "react";
import {
  ApiError,
  CustomerBookingStatus,
  manageCustomerBooking,
} from "@/lib/api";
import {
  customerBookingProgress,
  customerBookingStateLabel,
  formatCustomerBookingDate,
} from "@/lib/customer-booking";
import styles from "./manage.module.css";

export default function CustomerBookingPage() {
  const [token, setToken] = useState("");
  const [booking, setBooking] = useState<CustomerBookingStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [rescheduleOpen, setRescheduleOpen] = useState(false);
  const [note, setNote] = useState("");

  useEffect(() => {
    const managementToken = window.location.hash.slice(1).trim();
    setToken(managementToken);
    if (managementToken.length < 20) {
      setError(
        "This secure appointment link is incomplete. Open the full link from your confirmation message.",
      );
      setLoading(false);
      return;
    }
    void manageCustomerBooking(managementToken, "view")
      .then(setBooking)
      .catch((loadError) => setError(errorMessage(loadError)))
      .finally(() => setLoading(false));
  }, []);

  const act = async (action: "confirm" | "request_reschedule") => {
    setActing(true);
    setError(null);
    setNotice(null);
    try {
      const result = await manageCustomerBooking(
        token,
        action,
        action === "request_reschedule" ? note.trim() : undefined,
      );
      setBooking(result);
      setNotice(
        action === "confirm"
          ? "Your appointment window is confirmed."
          : "Your reschedule request was sent to dispatch.",
      );
      if (action === "request_reschedule") setRescheduleOpen(false);
    } catch (actionError) {
      setError(errorMessage(actionError));
    } finally {
      setActing(false);
    }
  };

  return (
    <main className={styles.page}>
      <header className={styles.brandBar}>
        <a href="/" aria-label="Signmons CallDesk home">
          <span className={styles.brandMark}>S</span>
          <span>
            <strong>Signmons</strong>
            <small>CallDesk</small>
          </span>
        </a>
        <span className={styles.secureLabel} aria-label="Secure booking link">
          <span className={styles.secureFull}>Secure booking link</span>
          <span className={styles.secureShort} aria-hidden="true">
            Private link
          </span>
        </span>
      </header>

      <section className={styles.shell}>
        {loading ? (
          <div className={styles.loading} role="status">
            <span />
            <p>Loading your booking…</p>
          </div>
        ) : error && !booking ? (
          <ErrorPanel message={error} />
        ) : booking ? (
          <>
            <div className={styles.intro}>
              <div>
                <p className={styles.eyebrow}>Booking #{booking.reference}</p>
                <h1>{customerBookingStateLabel(booking.bookingState)}</h1>
                <p>
                  Hi {firstName(booking.customerName)}. Review your service
                  window and the latest dispatch updates below.
                </p>
              </div>
              <span
                className={`${styles.stateBadge} ${styles[booking.bookingState]}`}
              >
                {booking.bookingState === "RESCHEDULE_REQUESTED"
                  ? "Dispatch reviewing"
                  : customerBookingStateLabel(booking.bookingState)}
              </span>
            </div>

            <Progress current={customerBookingProgress(booking.bookingState)} />

            {error ? (
              <div className={styles.error} role="alert">
                {error}
              </div>
            ) : null}
            {notice ? (
              <div className={styles.notice} role="status">
                {notice}
              </div>
            ) : null}

            <section className={styles.statusGrid} aria-label="Booking status">
              <StatusCard
                index="01"
                label="Service request"
                title={booking.serviceCategory}
                copy="Your service request is safely recorded."
                complete
              />
              <StatusCard
                index="02"
                label="Appointment window"
                title={booking.appointment.label}
                copy={
                  booking.customerResponse.label ||
                  "Review and confirm this arrival window."
                }
                attention={
                  booking.bookingState === "PENDING_CUSTOMER_CONFIRMATION"
                }
                complete={booking.bookingState === "CONFIRMED"}
              />
              <StatusCard
                index="03"
                label="Technician"
                title={booking.technician.label}
                copy="Dispatch updates this status as your service visit progresses."
                complete={
                  booking.technician.state !== "UNASSIGNED" &&
                  booking.technician.state !== "ASSIGNED"
                }
              />
              <StatusCard
                index="04"
                label="Payment"
                title={booking.payment.label}
                copy="Only secure payment requests from this service company will appear here."
                complete={booking.payment.state === "SUCCEEDED"}
              />
            </section>

            {booking.customerResponse.events.length ? (
              <section className={styles.activity}>
                <div>
                  <p className={styles.eyebrow}>Latest activity</p>
                  <h2>Your booking updates</h2>
                </div>
                <ol>
                  {booking.customerResponse.events.slice(0, 3).map((event) => (
                    <li key={event.id}>
                      <span />
                      <div>
                        <strong>{event.label}</strong>
                        {event.note ? <p>{event.note}</p> : null}
                      </div>
                      <time>{formatCustomerBookingDate(event.createdAt)}</time>
                    </li>
                  ))}
                </ol>
              </section>
            ) : null}

            {booking.availableActions.length ? (
              <section className={styles.actions}>
                <div>
                  <p className={styles.eyebrow}>Your response</p>
                  <h2>Does this appointment window work?</h2>
                  <p>
                    Your response goes directly to dispatch and is saved with
                    the booking record.
                  </p>
                </div>
                <div className={styles.actionButtons}>
                  {booking.availableActions.includes("confirm") ? (
                    <button
                      className={styles.primaryButton}
                      disabled={acting}
                      onClick={() => void act("confirm")}
                      type="button"
                    >
                      {acting ? "Saving…" : "Confirm this window"}
                    </button>
                  ) : null}
                  {booking.availableActions.includes("request_reschedule") ? (
                    <button
                      className={styles.secondaryButton}
                      disabled={acting}
                      onClick={() => setRescheduleOpen((open) => !open)}
                      type="button"
                    >
                      Request a different time
                    </button>
                  ) : null}
                </div>
                {rescheduleOpen ? (
                  <div className={styles.reschedulePanel}>
                    <label htmlFor="reschedule-note">
                      What timing would work better? <span>Optional</span>
                    </label>
                    <textarea
                      id="reschedule-note"
                      maxLength={500}
                      onChange={(event) => setNote(event.target.value)}
                      placeholder="Example: A morning window on Thursday or Friday"
                      value={note}
                    />
                    <button
                      disabled={acting}
                      onClick={() => void act("request_reschedule")}
                      type="button"
                    >
                      {acting ? "Sending…" : "Send request to dispatch"}
                    </button>
                  </div>
                ) : null}
              </section>
            ) : null}

            <footer className={styles.footer}>
              <strong>Keep this link private.</strong>
              <span>
                It provides access to this booking without requiring an account.
              </span>
            </footer>
          </>
        ) : null}
      </section>
    </main>
  );
}

function Progress({ current }: { current: number }) {
  return (
    <div
      className={styles.progress}
      aria-label={`Booking step ${current} of 3`}
    >
      {["Received", "Review", "Confirmed"].map((label, index) => (
        <div
          className={index + 1 <= current ? styles.progressActive : ""}
          key={label}
        >
          <span>{index + 1}</span>
          <small>{label}</small>
        </div>
      ))}
    </div>
  );
}

function StatusCard({
  index,
  label,
  title,
  copy,
  attention = false,
  complete = false,
}: {
  index: string;
  label: string;
  title: string;
  copy: string;
  attention?: boolean;
  complete?: boolean;
}) {
  return (
    <article
      className={`${styles.statusCard} ${attention ? styles.statusAttention : ""}`}
    >
      <div>
        <span>{index}</span>
        <small>
          {complete ? "✓ Updated" : attention ? "Action needed" : "In progress"}
        </small>
      </div>
      <p>{label}</p>
      <h2>{title}</h2>
      <small>{copy}</small>
    </article>
  );
}

function ErrorPanel({ message }: { message: string }) {
  return (
    <div className={styles.errorPanel} role="alert">
      <span>!</span>
      <h1>We could not open this booking</h1>
      <p>{message}</p>
      <small>Ask the service company to resend your secure booking link.</small>
    </div>
  );
}

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || "there";
}

function errorMessage(error: unknown): string {
  return error instanceof ApiError
    ? error.message
    : "We could not update your booking. Please try again.";
}
