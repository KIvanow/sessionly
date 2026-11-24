// What the operator of a hosted service does from the command line, straight
// against the database (DATABASE_URL):
//   node src/cli.ts org restore <id>
//   node src/cli.ts org purge
//   node src/cli.ts demo import
// The org commands are for an organisation its owner asked to delete: restore
// clears that during the seven days before its rows are removed, and purge
// removes every organisation that has been waiting longer than that.
// demo import copies the sessions of SESSIONLY_DEMO_REPO from SESSIONLY_DEMO_FROM
// into SESSIONLY_DEMO_ORG, as hosted/demo.ts says, in place of the copies made
// before; run it again (by hand, or from cron) to bring them up to date.
// Tokens and people are the core's: apps/server/src/cli.ts.
import { hashKeyOf, openDb } from "@sessionly/server";
import { demoFrom, importDemo } from "./hosted/demo.ts";
import { purgeDeletedOrgs, restoreOrg } from "./hosted/orgs.ts";

const [group, action, id] = process.argv.slice(2);

function usage(): never {
  console.error("usage: org restore <id> | org purge | demo import");
  process.exit(2);
}
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set: these are for a hosted service's database.");
  process.exit(2);
}
if (group !== "org" && group !== "demo") usage();

const db = await openDb(process.env.DATABASE_URL);
try {
  if (group === "org" && action === "purge" && !id) {
    const gone = await purgeDeletedOrgs(db);
    console.log(gone.length ? `Removed ${gone.join(", ")}.` : "Nothing was due to be removed.");
  } else if (group === "org" && action === "restore" && id) {
    // Restoring is how one that is deleted comes back.
    if (await restoreOrg(db, id)) console.log(`"${id}" is restored. Its tokens work again.`);
    else {
      console.error(`There is no organisation "${id}" waiting to be deleted.`);
      process.exitCode = 1;
    }
  } else if (group === "org") {
    usage();
  } else if (group === "demo" && action === "import" && !id) {
    const demo = demoFrom(process.env);
    const there = demo && !("problem" in demo)
      ? await db.query<{ id: string }>(`SELECT id FROM orgs WHERE id IN ($1, $2) AND deleted_at IS NULL`, [demo.from, demo.org])
      : [];
    if (!demo) {
      console.error("SESSIONLY_DEMO_FROM, SESSIONLY_DEMO_REPO and SESSIONLY_DEMO_ORG are not set: there is nothing to import.");
      process.exitCode = 1;
    } else if ("problem" in demo) {
      console.error(demo.problem);
      process.exitCode = 1;
    } else if (there.length < 2) {
      console.error(`There is no organisation "${there.some((o) => o.id === demo.from) ? demo.org : demo.from}".`);
      process.exitCode = 1;
    } else {
      const done = await importDemo((fn) => db.asOrg(demo.from, fn), (fn) => db.asOrg(demo.org, fn), demo, {
        key: hashKeyOf(process.env),
        log: (err) => console.error(err),
      });
      console.log(
        `${demo.repo} in ${demo.org}: ${done.copied} sessions copied, ${done.skipped} turned down, ${done.removed} copies removed; ` +
          `${done.matched} pull requests matched again${done.failed ? `, ${done.failed} failed` : ""}.`,
      );
      if (done.failed) process.exitCode = 1;
    }
  } else {
    usage();
  }
} finally {
  await db.close();
}
