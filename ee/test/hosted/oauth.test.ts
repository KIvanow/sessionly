// What Google and GitHub are asked, and what is made of their answers:
// against a server here that answers as they do.
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { challengeOf, errorWord, github, google, GITHUB, GOOGLE, isSetupWord, PATIENCE, ProviderProblem } from "../../src/hosted/oauth.ts";

interface Asked {
  method: string;
  path: string;
  headers: IncomingMessage["headers"];
  form: Record<string, string>;
}

let server: Server;
let base = "";
const asked: Asked[] = [];
// What the next request to a path is answered with. `stalls`: the answer
// begins and then nothing more comes. `cut`: it begins and the connection ends.
const answers = new Map<string, { status?: number; body: unknown; stalls?: boolean; cut?: boolean }>();

before(async () => {
  server = createServer((request, response) => {
    let text = "";
    request.on("data", (chunk) => (text += chunk));
    request.on("end", () => {
      const path = (request.url ?? "").split("?")[0] ?? "";
      asked.push({ method: request.method ?? "", path: request.url ?? "", headers: request.headers, form: Object.fromEntries(new URLSearchParams(text)) });
      const answer = answers.get(path) ?? { status: 404, body: { error: "not_found" } };
      response.writeHead(answer.status ?? 200, { "content-type": typeof answer.body === "string" ? "text/html" : "application/json" });
      const body = typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body);
      if (answer.stalls || answer.cut) {
        response.write(body.slice(0, 5));
        if (answer.cut) setTimeout(() => response.destroy(), 20);
        return;
      }
      response.end(body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(resolve));
});

const client = { id: "the-id", secret: "the-secret" };
const answer = { code: "the-code", redirectUri: "https://app.test/api/v1/auth/x/callback", verifier: "the-verifier" };
const problem = async (work: Promise<unknown>) => {
  const err = await work.then(
    () => null,
    (thrown: unknown) => thrown,
  );
  assert.ok(err instanceof ProviderProblem, String(err));
  // Whatever went wrong, what it says carries nothing that is a secret.
  assert.doesNotMatch(err.message, /the-secret|the-code|the-verifier|the-access/);
  return err.message;
};
/** The provider's own word for what went wrong, if the error carries one. */
const word = async (work: Promise<unknown>) => (await work.then(() => null, (thrown: ProviderProblem) => thrown))?.word;

test("the secret a provider is shown on the way back is the one whose hash it was given", () => {
  // The example of RFC 7636, appendix B.
  assert.equal(challengeOf("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
});

test("Google: the account, and its one address if Google has verified it", async () => {
  const at = { authorize: `${base}/auth`, token: `${base}/token`, userinfo: `${base}/userinfo` };
  const provider = google(client, at);
  const to = new URL(provider.authorizeUrl({ redirectUri: answer.redirectUri, state: "the-state", challenge: "the-challenge" }));
  assert.deepEqual(Object.fromEntries(to.searchParams), {
    client_id: "the-id",
    redirect_uri: answer.redirectUri,
    response_type: "code",
    scope: "openid email",
    state: "the-state",
    code_challenge: "the-challenge",
    code_challenge_method: "S256",
    prompt: "select_account",
  });
  // Where Google really is.
  assert.match(google(client).authorizeUrl({ redirectUri: "r", state: "s", challenge: "c" }), /^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/);
  assert.deepEqual([new URL(GOOGLE.token).host, new URL(GOOGLE.userinfo).host], ["oauth2.googleapis.com", "openidconnect.googleapis.com"]);

  answers.set("/token", { body: { access_token: "the-access", id_token: "unused", token_type: "Bearer" } });
  answers.set("/userinfo", { body: { sub: "108204268033311374519", email: "Ann@Example.com", email_verified: true } });
  asked.length = 0;
  // The account is Google's number for it, which stays its own; the address is what Google says of it now.
  assert.deepEqual(await provider.who(answer), { account: "108204268033311374519", emails: ["Ann@Example.com"] });
  const [token, userinfo] = asked;
  assert.equal(token?.method, "POST");
  assert.deepEqual(token?.form, {
    grant_type: "authorization_code",
    code: "the-code",
    client_id: "the-id",
    client_secret: "the-secret",
    redirect_uri: answer.redirectUri,
    code_verifier: "the-verifier",
  });
  assert.deepEqual([userinfo?.method, userinfo?.headers.authorization], ["GET", "Bearer the-access"]);

  // An address Google has not verified is not one it vouches for.
  for (const who of [{ email: "ann@example.com", email_verified: false }, { email: "ann@example.com" }, { email: "ann@example.com", email_verified: "true" }, {}]) {
    answers.set("/userinfo", { body: { sub: "1", ...who } });
    assert.deepEqual(await provider.who(answer), { account: "1", emails: [] }, JSON.stringify(who));
  }
  // Without the account there is nobody to sign in.
  for (const who of [{ email: "ann@example.com", email_verified: true }, { sub: 7, email: "ann@example.com", email_verified: true }, { sub: "" }, null]) {
    answers.set("/userinfo", { body: who });
    assert.equal(await problem(provider.who(answer)), "Google's userinfo endpoint named no account", JSON.stringify(who));
  }
  // Google says no, or something that is not an answer.
  answers.set("/token", { status: 400, body: { error: "invalid_grant", error_description: "the-code was used" } });
  assert.equal(await problem(provider.who(answer)), "Google's token endpoint answered 400 (invalid_grant)");
  assert.equal(await word(provider.who(answer)), "invalid_grant");
  // Its word for a server that is set up wrongly is kept as that, and nothing longer or stranger is.
  answers.set("/token", { status: 401, body: { error: "invalid_client", error_description: "the-secret is wrong" } });
  assert.equal(await problem(provider.who(answer)), "Google's token endpoint answered 401 (invalid_client)");
  assert.equal(isSetupWord(await word(provider.who(answer))), true);
  answers.set("/token", { status: 400, body: { error: "the-secret and a sentence" } });
  assert.equal(await problem(provider.who(answer)), "Google's token endpoint answered 400");
  assert.deepEqual([errorWord("Invalid_Client"), errorWord("x y"), errorWord(7), errorWord("a".repeat(61))], ["invalid_client", undefined, undefined, undefined]);
  assert.deepEqual([isSetupWord("redirect_uri_mismatch"), isSetupWord("invalid_grant"), isSetupWord(undefined)], [true, false, false]);
  answers.set("/token", { body: { token_type: "Bearer" } });
  assert.equal(await problem(provider.who(answer)), "Google's token endpoint gave no access");
  // Something that is not an answer is said as that, not as access refused.
  answers.set("/token", { body: "<html>the-secret</html>" });
  assert.equal(await problem(provider.who(answer)), "Google's token endpoint answered 200 with something that is not JSON");
  answers.set("/token", { status: 502, body: "<html>bad gateway</html>" });
  assert.equal(await problem(provider.who(answer)), "Google's token endpoint answered 502 with something that is not JSON");
  // So is an answer that begins and does not end: cut off, or stalled until the time for it is up.
  answers.set("/token", { body: { access_token: "the-access" }, cut: true });
  assert.match(await problem(provider.who(answer)), /^Google's token endpoint did not answer, or not to the end \(\w+\)$/);
  answers.set("/token", { body: { access_token: "the-access" }, stalls: true });
  const patience = PATIENCE.ms;
  PATIENCE.ms = 250;
  try {
    const began = Date.now();
    assert.equal(await problem(provider.who(answer)), "Google's token endpoint did not answer, or not to the end (TimeoutError)");
    assert.ok(Date.now() - began < 2000, `${Date.now() - began} ms`);
  } finally {
    PATIENCE.ms = patience;
  }
  answers.set("/token", { body: { access_token: "the-access" } });
  answers.set("/userinfo", { status: 401, body: { error: "invalid_token" } });
  assert.equal(await problem(provider.who(answer)), "Google's userinfo endpoint answered 401 (invalid_token)");
  // Nobody there.
  const nowhere = google(client, { ...at, token: "http://127.0.0.1:9/token" });
  assert.match(await problem(nowhere.who(answer)), /^Google's token endpoint did not answer/);
});

test("GitHub: the account, and every address it has verified, the primary one first", async () => {
  const at = { authorize: `${base}/authorize`, token: `${base}/access_token`, user: `${base}/user`, emails: `${base}/user/emails` };
  const provider = github(client, at);
  const to = new URL(provider.authorizeUrl({ redirectUri: answer.redirectUri, state: "the-state", challenge: "the-challenge" }));
  assert.deepEqual(Object.fromEntries(to.searchParams), {
    client_id: "the-id",
    redirect_uri: answer.redirectUri,
    scope: "user:email",
    state: "the-state",
    code_challenge: "the-challenge",
    code_challenge_method: "S256",
  });
  assert.match(github(client).authorizeUrl({ redirectUri: "r", state: "s", challenge: "c" }), /^https:\/\/github\.com\/login\/oauth\/authorize\?/);
  assert.deepEqual(
    [GITHUB.token, GITHUB.user, GITHUB.emails],
    ["https://github.com/login/oauth/access_token", "https://api.github.com/user", "https://api.github.com/user/emails"],
  );

  answers.set("/access_token", { body: { access_token: "the-access", token_type: "bearer", scope: "user:email" } });
  answers.set("/user", { body: { login: "kit", id: 583231, email: null } });
  answers.set("/user/emails", {
    body: [
      { email: "second@work.example", primary: false, verified: true },
      { email: "unverified@old.example", primary: false, verified: false },
      { email: "1234+kit@users.noreply.github.com", primary: false, verified: true },
      { email: "kit@home.example", primary: true, verified: true },
      { email: 7, primary: false, verified: true },
      null,
    ],
  });
  asked.length = 0;
  // The account is its number: a name can be changed, and then be someone else's.
  assert.deepEqual(await provider.who(answer), { account: "583231", emails: ["kit@home.example", "second@work.example"] });
  const token = asked[0];
  const user = asked.find((each) => each.path === "/user");
  const emails = asked.find((each) => each.path.startsWith("/user/emails"));
  assert.equal(asked.length, 3);
  assert.deepEqual([user?.method, user?.headers.authorization], ["GET", "Bearer the-access"]);
  assert.equal(token?.headers.accept, "application/json");
  assert.deepEqual(token?.form, {
    code: "the-code",
    client_id: "the-id",
    client_secret: "the-secret",
    redirect_uri: answer.redirectUri,
    code_verifier: "the-verifier",
  });
  assert.equal(emails?.path, "/user/emails?per_page=100");
  assert.deepEqual(
    [emails?.headers.authorization, emails?.headers.accept, emails?.headers["user-agent"]],
    ["Bearer the-access", "application/vnd.github+json", "sessionly"],
  );
  // A primary address that is not verified is no address at all.
  answers.set("/user/emails", { body: [{ email: "kit@home.example", primary: true, verified: false }] });
  assert.deepEqual(await provider.who(answer), { account: "583231", emails: [] });
  // Without the account's number there is nobody to sign in.
  for (const who of [{ login: "kit" }, { id: "583231" }, { id: 0 }, { id: 1.5 }, null]) {
    answers.set("/user", { body: who });
    assert.equal(await problem(provider.who(answer)), "GitHub's account had no id", JSON.stringify(who));
  }
  answers.set("/user", { body: { id: 583231 } });

  // GitHub says no with a 200.
  answers.set("/access_token", { body: { error: "bad_verification_code", error_description: "The code passed is incorrect or expired." } });
  assert.equal(await problem(provider.who(answer)), "GitHub's token endpoint gave no access (bad_verification_code)");
  answers.set("/access_token", { body: { error: "incorrect_client_credentials" } });
  assert.equal(isSetupWord(await word(provider.who(answer))), true);
  answers.set("/access_token", { body: { access_token: "the-access" } });
  answers.set("/user/emails", { status: 403, body: { message: "Resource not accessible" } });
  assert.equal(await problem(provider.who(answer)), "GitHub's list of addresses answered 403");
  answers.set("/user/emails", { body: { message: "not a list" } });
  assert.equal(await problem(provider.who(answer)), "GitHub's list of addresses was not a list");
});
