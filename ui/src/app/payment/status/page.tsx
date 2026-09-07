"use client";

import { useEffect, useState } from "react";
import styles from "./status.module.css";

export default function PaymentStatusPage() {
  const [outcome, setOutcome] = useState<"success" | "cancel" | "unknown">(
    "unknown",
  );

  useEffect(() => {
    const value = new URLSearchParams(window.location.search).get("payment");
    setOutcome(value === "success" || value === "cancel" ? value : "unknown");
  }, []);

  const submitted = outcome === "success";
  return (
    <main className={styles.page}>
      <section className={styles.card}>
        <span aria-hidden="true">{submitted ? "✓" : "i"}</span>
        <p>Signmons secure payment</p>
        <h1>
          {submitted
            ? "Your payment was submitted"
            : outcome === "cancel"
              ? "Payment was not completed"
              : "Check your booking for payment status"}
        </h1>
        <p>
          {submitted
            ? "Stripe is confirming the payment. Return to your original booking tab and refresh to see the verified status."
            : "Return to your original booking tab to continue or request help from the service company."}
        </p>
        <small>
          Keep your secure booking link private. This page does not contain your
          card details.
        </small>
      </section>
    </main>
  );
}
