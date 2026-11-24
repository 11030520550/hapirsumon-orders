// Builds the local database in Node (in memory) exactly as the browser does, and prints what the data set
// contains plus consistency checks. Usage: node testing/local-pg/seed-check.mjs [demo|basic]
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildDatabase } from "./local-db.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const { PGlite } = await import(pathToFileURL(path.join(root, "testing/postgres/package/dist/index.js")).href);
const seed = process.argv[2] || "demo";
const pg = await PGlite.create();
const t0 = Date.now();
await buildDatabase(pg, { readText: (name) => readFile(path.join(root, name), "utf8"), seed, onPhase: (p) => process.stderr.write(`  ${p}\n`) });
const q = async (text) => (await pg.query(text)).rows;
const one = async (text) => (await q(text))[0];
console.log(`built "${seed}" in ${Date.now() - t0} ms`);
console.log("orders:", JSON.stringify(await one(`select count(*) n, count(*) filter (where billing_mode='cash') cash, count(*) filter (where billing_mode='credits') credits,
  count(*) filter (where cancelled_at is not null) cancelled, min(order_number) lo, max(order_number) hi, min(entered_at)::text first_day, max(entered_at)::text last_day from public.orders`)));
console.log("files:", JSON.stringify(await q("select file_status, placement_status, count(*)::int n from public.orders where cancelled_at is null group by 1,2 order by 1,2")));
console.log("sheets:", JSON.stringify(await q(`select s.sheet_number, s.publication_date::text as pub, s.is_closed, s.closed_by_kind as kind, (select count(*)::int from public.orders o where o.sheet_number = s.sheet_number and o.cancelled_at is null) as orders
  from public.sheet_overview s order by s.sheet_number`)).slice(0, 2000));
console.log("clients:", JSON.stringify(await one(`select count(*) n, (select count(distinct client_id) from public.orders) with_orders from public.clients`)));
console.log("credit balances:", JSON.stringify(await q("select client_id, credit_balance::float b from public.business_client_credit_balances where credit_balance <> 0 or client_id in (select client_id from public.credit_ledger) order by b")));
console.log("packages:", JSON.stringify(await q("select client_id, package_name_snapshot, credits_granted::float, installment_count, starts_on::text from public.customer_packages order by starts_on")));
console.log("money:", JSON.stringify(await one("select * from public.business_financial_totals")));
console.log("payment kinds:", JSON.stringify(await q(`select payment_status, count(*)::int n, sum(cash_outstanding)::float open from public.business_financial_summary group by 1 order by 1`)));
console.log("due:", JSON.stringify(await one(`select count(*) filter (where cash_outstanding > 0 and due_on < current_date) overdue, count(*) filter (where cash_outstanding > 0 and due_on >= current_date) upcoming,
  count(*) filter (where cash_outstanding > 0 and due_on is null) undated from public.business_financial_summary`)));
console.log("events:", JSON.stringify(await q("select event_type, count(*)::int n from public.business_payment_events group by 1")));
const tot = await one("select total_cash_billed b, total_cash_received r, total_cash_outstanding o, orders_missing_obligation m, payment_status_mismatches x from public.business_financial_totals");
const cred = await one("select (select coalesce(sum(delta),0) from public.credit_ledger) l, (select coalesce(sum(credit_balance),0) from public.business_client_credit_balances) b");
const ok = Math.round(tot.b * 100) === Math.round((Number(tot.r) + Number(tot.o)) * 100) && Number(tot.m) === 0 && Number(tot.x) === 0 && Number(cred.l) === Number(cred.b);
console.log(ok ? "CONSISTENT: billed = received + open, no missing charge, no status mismatch, credits = ledger" : `INCONSISTENT ${JSON.stringify({ tot, cred })}`);
process.exit(ok ? 0 : 1);
