import type { Arrival, AuthOptions, Membership } from "@sessionly/schema";
import { useState } from "react";
import { savedSessions, type Saved } from "./api.ts";
import type { Where } from "./arrival.ts";
import { Brand } from "./Brand.tsx";
import { PROVIDERS } from "./Login.tsx";
import { reads } from "./lookalike.ts";

/**
 * An organisation this browser is signed in to that has this name and is
 * not this one. Anyone can make an organisation with any name, so a name
 * alone does not say which one this is.
 */
function sameNameElsewhere(name: string, orgId: string | null): Saved | undefined {
  return savedSessions().find((s) => s.org !== orgId && reads(s.name) === reads(name));
}

/**
 * Back from Google or GitHub. Being in an organisation is someone else's
 * doing (anyone can add any address to one of theirs), so nobody is taken
 * into one they have not chosen: they are shown which there are, and asked.
 */
export function Arrived({
  arrival,
  options,
  enter,
  onMore,
  onCancel,
}: {
  arrival: Arrival;
  options: AuthOptions | null;
  /** Go on. Rejects with what to tell them if that did not work. */
  enter: (where: Where) => Promise<void>;
  /** List the next organisations they were added to. */
  onMore: () => Promise<void>;
  onCancel: () => void;
}) {
  const create = arrival.create;
  const maySignUp = options?.signup === true;
  // The demo, which anyone may join: making an organisation of their own is offered beside it, as plainly.
  const offersDemo = arrival.orgs.some((org) => org.demo === true);
  // What they came for, until they choose otherwise; and never the form
  // for creating one where that is not open, whenever that becomes known.
  const [chosen, setChosen] = useState<boolean | null>(null);
  const creating = (chosen ?? create) && maySignUp;
  const setCreating = (value: boolean) => setChosen(value);
  const [orgName, setOrgName] = useState("");
  const [invite, setInvite] = useState("");
  const [failed, setFailed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const email = arrival.emails[0] ?? "";

  const go = (where: Where) => {
    setFailed(null);
    setBusy(true);
    enter(where)
      .catch((err: Error) => setFailed(err.message))
      .finally(() => setBusy(false));
  };

  if (creating) {
    const twin = orgName.trim() ? sameNameElsewhere(orgName, null) : undefined;
    return (
      <main className="center">
        <Brand />
        <form
          className="card login"
          onSubmit={(e) => {
            e.preventDefault();
            go({ org_name: orgName, invite_code: invite || undefined });
          }}
        >
          <h1>Create an organisation</h1>
          <dl className="facts">
            <dt>Its owner</dt>
            <dd>{email}</dd>
            <dt>Signed in with</dt>
            <dd>{PROVIDERS[arrival.provider]}</dd>
          </dl>
          <label>
            Organisation
            <input
              required
              minLength={2}
              maxLength={60}
              value={orgName}
              onChange={(e) => setOrgName(e.target.value)}
              autoComplete="organization"
              autoFocus
            />
          </label>
          {options?.inviteCode && (
            <label>
              Invitation code
              <input required value={invite} onChange={(e) => setInvite(e.target.value)} autoComplete="off" />
            </label>
          )}
          {twin && (
            <p role="alert">
              This browser is already signed in to an organisation called {twin.name} ({twin.org}). This creates a
              second, separate one with the same name.
            </p>
          )}
          {failed && <p role="alert">{failed}</p>}
          <button type="submit" disabled={busy || !orgName.trim()}>
            Create it
          </button>
          <p className="muted">
            Letters, digits, spaces and & ' , ( ) + - in the name. The organisation is created now, with this address
            as its owner.
          </p>
          <p className="ways">
            {arrival.orgs.length > 0 && (
              <button type="button" className="quiet" onClick={() => (setFailed(null), setCreating(false))}>
                Sign in to one I am in
              </button>
            )}
            <button type="button" className="quiet" onClick={onCancel}>
              Not now
            </button>
          </p>
        </form>
      </main>
    );
  }

  return (
    <main className="center">
      <Brand />
      <div className="card login">
        <h1>{arrival.orgs.length ? "Sign in where?" : "Nowhere to sign in yet"}</h1>
        {arrival.orgs.length === 0 && (
          <p>
            No organisation here has {arrival.emails.join(" or ")} as a member. If you were added under another
            address, sign in with an account that has it, or ask whoever added you to add this one.
            {create && !maySignUp && " Creating organisations is not open here."}
          </p>
        )}
        {arrival.orgs.map((org) => (
          <Place key={org.user_id} org={org} busy={busy} onChoose={() => go({ user_id: org.user_id })} />
        ))}
        {arrival.more > 0 && (
          <p className="muted">
            {arrival.more === 1 ? "One more organisation has" : `${arrival.more} more organisations have`} added{" "}
            {arrival.emails.length > 1 ? "one of these addresses" : "this address"}, earlier than the ones above.{" "}
            <button
              type="button"
              className="quiet"
              disabled={busy}
              onClick={() => {
                setFailed(null);
                setBusy(true);
                onMore()
                  .catch((err: Error) => setFailed(err.message))
                  .finally(() => setBusy(false));
              }}
            >
              Show more
            </button>
          </p>
        )}
        {/* Beside the demo, making one's own organisation is offered as plainly. */}
        {offersDemo && maySignUp && (
          <>
            <p className="or">or</p>
            <button type="button" className="primary" disabled={busy} onClick={() => (setFailed(null), setCreating(true))}>
              Create an organisation
            </button>
          </>
        )}
        {failed && <p role="alert">{failed}</p>}
        <p className="ways">
          {maySignUp && !offersDemo && (
            <button type="button" className="quiet" onClick={() => (setFailed(null), setCreating(true))}>
              Create an organisation
            </button>
          )}
          <button type="button" className="quiet" onClick={onCancel}>
            Not now
          </button>
        </p>
      </div>
    </main>
  );
}

/** One organisation to sign in to, with what tells it from another of the same name. */
function Place({ org, busy, onChoose }: { org: Membership; busy: boolean; onChoose: () => void }) {
  const twin = sameNameElsewhere(org.org_name, org.org_id);
  if (org.demo) {
    return (
      <section className="place">
        <dl className="facts">
          <dt>Demo</dt>
          <dd>{org.org_name}</dd>
          <dt>As</dt>
          <dd>{org.email}, a viewer</dd>
        </dl>
        <p className="muted">
          Real work, shown to anyone who signs in: its sessions, pull requests and what they cost. You can look around
          and change nothing.
        </p>
        <button type="button" className="primary" disabled={busy} onClick={onChoose}>
          View the demo
        </button>
      </section>
    );
  }
  return (
    <section className="place">
      <dl className="facts">
        <dt>Organisation</dt>
        <dd>{org.org_name}</dd>
        <dt>Its id</dt>
        <dd>
          <code>{org.org_id}</code>
        </dd>
        <dt>As</dt>
        <dd>{org.email}</dd>
        {org.first_time && (
          <>
            <dt>Added by</dt>
            <dd>
              {org.invited_by ??
                (org.invited_via === "token"
                  ? "an admin token of that organisation, not a person who signed in"
                  : "not recorded")}
            </dd>
          </>
        )}
      </dl>
      {twin && (
        <p role="alert">
          This is not the {twin.name} this browser is signed in to: that one is {twin.org}. Anyone can give an
          organisation any name. Go on only if you {org.invited_by ? `know who ${org.invited_by} is and` : ""} expected
          to be added to it.
        </p>
      )}
      {org.first_time && !twin && (
        <p className="muted">
          You have not signed in to this organisation before. A name can be anyone's choice
          {org.invited_by
            ? ": check who added you."
            : ", and this page cannot say who added you: go on only if you were expecting this."}{" "}
          Sessions you upload after signing in here belong to it.
        </p>
      )}
      {org.other_account ? (
        <p role="alert">
          This organisation was signed in to before with another {PROVIDERS[org.other_account]} account, and only that
          account gets in. Sign in with that one. If it is gone, another admin of the organisation can let you in with
          a new one from its Team page; if there is no other admin, whoever runs this server can.
        </p>
      ) : (
        <button type="button" className="primary" disabled={busy} onClick={onChoose}>
          Sign in
        </button>
      )}
    </section>
  );
}
