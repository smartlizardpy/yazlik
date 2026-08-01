import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Privacy — Yazlık",
  description: "What Yazlık stores, and what it does not.",
};

/**
 * Written from what the code actually does, not from a template.
 *
 * Every claim here is checkable against a file: the guest fields are the zod
 * schema in `app/_actions/booking.ts`, the session cookie is better-auth's,
 * and "no analytics" is true because there is no analytics package in
 * `package.json`. If any of that changes, this page is wrong and has to change
 * with it.
 */
export default function PrivacyPage() {
  return (
    <>
      <h1>Privacy</h1>

      <p>
        Yazlık is a booking link for one family&rsquo;s summer house. It holds
        the least it can get away with, because there is no reason for it to
        hold more.
      </p>

      <h2>If you are a guest</h2>
      <p>
        You have no account and no password. When you ask for dates, the house&rsquo;s
        owner receives your <strong>name</strong>, your <strong>email
        address</strong>, <strong>how many of you</strong> are coming, the{" "}
        <strong>dates</strong> you asked for, and the <strong>note</strong> you
        wrote, if you wrote one.
      </p>
      <p>
        That is the whole list. Your email is used to send you the answer and,
        if you are coming, a reminder before you arrive. It is not used for
        anything else and it goes nowhere else.
      </p>

      <h2>If you own a house</h2>
      <p>
        Signing in stores your <strong>name</strong> and <strong>email
        address</strong>. If you sign in with Google, Google tells us those two
        things and nothing more — Yazlık never asks for access to your Google
        account beyond confirming who you are.
      </p>
      <p>
        Anything you write about the house — its name, the town, the
        description, the guide, the photographs — is stored because it is the
        product.
      </p>

      <h2>Cookies</h2>
      <p>
        One, and only for owners: the cookie that keeps you signed in. There is
        no analytics, no tracking pixel, no advertising network and no
        third-party cookie anywhere in this app. A guest browsing a house link
        is given no cookie at all.
      </p>

      <h2>Money</h2>
      <p>
        None changes hands in Yazlık, so there is no card number, no billing
        address and no payment processor. There is nothing here to steal.
      </p>

      <h2>Where it is kept</h2>
      <p>
        In a Postgres database run by Neon, and on Vercel, which serves the
        site. Photographs are stored with them too. Email is sent by the mail
        provider configured for this install.
      </p>

      <h2>How long</h2>
      <p>
        Bookings stay until the house&rsquo;s owner deletes them or deletes the
        house. Deleting a house deletes its bookings, guide and photographs with
        it. Deleting an owner account deletes the house.
      </p>

      <h2>Asking for your data, or its removal</h2>
      <p>
        Ask the person who sent you the link — they own the house and the data
        that sits under it, and they can delete any booking outright.
      </p>
    </>
  );
}
