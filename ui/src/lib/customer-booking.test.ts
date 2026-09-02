import assert from "node:assert/strict";
import test from "node:test";
import {
  customerBookingProgress,
  customerBookingStateLabel,
  formatCustomerBookingDate,
} from "./customer-booking.ts";

test("customer booking status copy is clear and action oriented", () => {
  assert.equal(
    customerBookingStateLabel("PENDING_CUSTOMER_CONFIRMATION"),
    "Waiting for your confirmation",
  );
  assert.equal(
    customerBookingStateLabel("RESCHEDULE_REQUESTED"),
    "Reschedule request sent",
  );
});

test("booking progress preserves the pending reschedule state", () => {
  assert.equal(customerBookingProgress("REQUEST_RECEIVED"), 1);
  assert.equal(customerBookingProgress("RESCHEDULE_REQUESTED"), 2);
  assert.equal(customerBookingProgress("CONFIRMED"), 3);
});

test("customer booking activity is formatted in the tenant timezone", () => {
  assert.equal(
    formatCustomerBookingDate("2026-09-02T19:00:00.000Z", "America/New_York"),
    "Sep 2, 3:00 PM",
  );
});
