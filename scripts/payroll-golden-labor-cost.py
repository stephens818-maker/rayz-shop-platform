"""
Adds the Payroll Report's labor cost to the payroll golden fixtures (Charles, Oct 22: OT pay counts
in labor cost, so in Employee Cost and Gross Profit; Oct 28: training pay too, and Q11: training is
on top of clocked hours, so it carries its share of the OT).

    python3 scripts/payroll-golden-labor-cost.py [dir ...]

Each dir (default: tests/fixtures/payroll-golden/anon and, when present, .../private) gets, in place:

- golden.json, every row's expected_raw: ot_pay (1.5 x wage x OT hours, $0 on a row whose hourly
  pay is typed 0), training_pay (wage x training hours: the golden period has no training rates),
  training_ot_pay (training's share of the OT pay: OT pay x training hours / (worked + training
  hours)), training_cost (training pay + training_ot_pay) and labor_cost (Total Wages + OT pay +
  training pay; training_ot_pay is already in the OT pay).
- golden.json, corrected_location_totals_all_rows: ot_pay, training_pay, training_ot_pay,
  training_cost, labor_cost and gross_profit_after_labor per shop.
- totals_expected.json, grand: otPay, trainingPay, trainingOtPay, trainingCost, laborCost and
  grossProfitAfterLabor.

The workbook's OT hours are typed, so these are the typed hours' shares: the OT the workbook misses
by leaving training out of the 40 isn't here (docs/payroll-workbook-discrepancies.md section 16).
The export is unchanged: it carries OT and training hours only. Prints totals for the anonymized
fixture and counts only for the real one.
"""
import json, os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GOLDEN = os.path.join(ROOT, "tests/fixtures/payroll-golden")
OT_MULTIPLIER = 1.5
RETIRED = ("labor_cost_with_training",)
RETIRED_GRAND = ("laborCostWithTraining",)


def row_cost(i, e):
    pay_wage = 0.0 if i["hourly_total_override"] == 0 else i["wage"]
    ot, training = i["ot_hours"], i["training_hours"]
    ot_pay = OT_MULTIPLIER * pay_wage * ot
    training_pay = pay_wage * training
    basis = i["hours"] + ot + training
    share = min(ot, ot * training / basis) if ot > 0 and basis > 0 else 0.0
    training_ot_pay = OT_MULTIPLIER * pay_wage * share
    return dict(
        ot_pay=ot_pay,
        training_pay=training_pay,
        training_ot_pay=training_ot_pay,
        training_cost=training_pay + training_ot_pay,
        labor_cost=e["total_wages"] + ot_pay + training_pay,
    )


def main(dirs):
    for d in dirs:
        g = json.load(open(os.path.join(d, "golden.json")))
        for r in g["rows"]:
            for k in RETIRED:
                r["expected_raw"].pop(k, None)
            r["expected_raw"].update(row_cost(r["inputs"], r["expected_raw"]))
        for shop, t in g["corrected_location_totals_all_rows"].items():
            rows = [r["expected_raw"] for r in g["rows"] if r["inputs"]["location"] == shop]
            for k in RETIRED:
                t.pop(k, None)
            for k in ("ot_pay", "training_pay", "training_ot_pay", "training_cost"):
                t[k] = sum(x[k] for x in rows)
            t["labor_cost"] = t["total_wages"] + t["ot_pay"] + t["training_pay"]
            t["gross_profit_after_labor"] = t["service"] - t["labor_cost"]
        with open(os.path.join(d, "golden.json"), "w") as f:
            f.write(json.dumps(g, indent=1) + "\n")

        totals = g["corrected_location_totals_all_rows"].values()
        s = lambda k: sum(t[k] for t in totals)
        grand = dict(
            otPay=s("ot_pay"),
            trainingPay=s("training_pay"),
            trainingOtPay=s("training_ot_pay"),
            trainingCost=s("training_cost"),
            laborCost=s("labor_cost"),
            grossProfitAfterLabor=s("gross_profit_after_labor"),
        )
        te = os.path.join(d, "totals_expected.json")
        if os.path.exists(te):
            want = json.load(open(te))
            for k in RETIRED_GRAND:
                want["grand"].pop(k, None)
            want["grand"].update({k: round(v, 4) for k, v in grand.items()})
            with open(te, "w") as f:
                f.write(json.dumps(want, indent=1) + "\n")
        name = os.path.relpath(d, ROOT)
        if "private" in name:
            print(f"{name}: {len(g['rows'])} rows, {sum(1 for r in g['rows'] if r['expected_raw']['ot_pay'])} with OT pay, {sum(1 for r in g['rows'] if r['expected_raw']['training_ot_pay'])} with training's share of it")
        else:
            print(
                f"{name}: {len(g['rows'])} rows; Employee Cost {s('total_wages'):.4f} + OT pay {grand['otPay']:.4f} + training pay {grand['trainingPay']:.4f}"
                f" = labor cost {grand['laborCost']:.4f}; training cost {grand['trainingCost']:.4f} (training's share of OT pay {grand['trainingOtPay']:.4f})"
            )


main(sys.argv[1:] or [p for p in (os.path.join(GOLDEN, "anon"), os.path.join(GOLDEN, "private")) if os.path.exists(os.path.join(p, "golden.json"))])
