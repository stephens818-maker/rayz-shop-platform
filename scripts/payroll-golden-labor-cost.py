"""
Adds the Payroll Report's labor cost to the payroll golden fixtures (Charles, Oct 22: OT pay counts
in labor cost, so in Employee Cost and Gross Profit).

    python3 scripts/payroll-golden-labor-cost.py [dir ...]

Each dir (default: tests/fixtures/payroll-golden/anon and, when present, .../private) gets, in place:

- golden.json, every row's expected_raw: ot_pay (1.5 x wage x OT hours, $0 on a row whose hourly
  pay is typed 0), training_pay (wage x training hours) and labor_cost (Total Wages + OT pay).
- golden.json, corrected_location_totals_all_rows: ot_pay, training_pay, labor_cost,
  labor_cost_with_training and gross_profit_after_labor per shop.
- totals_expected.json, grand: otPay, trainingPay, laborCost, laborCostWithTraining and
  grossProfitAfterLabor.

Training pay stays out of labor cost until Charles answers Q11 (do clocked hours already include
training?); labor_cost_with_training is the figure if it goes in. The export is unchanged: it
carries OT hours only. Prints totals for the anonymized fixture and counts only for the real one.
"""
import json, os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GOLDEN = os.path.join(ROOT, "tests/fixtures/payroll-golden")
OT_MULTIPLIER = 1.5


def row_cost(i, e):
    pay_wage = 0.0 if i["hourly_total_override"] == 0 else i["wage"]
    ot_pay = OT_MULTIPLIER * pay_wage * i["ot_hours"]
    training_pay = pay_wage * i["training_hours"]
    return dict(ot_pay=ot_pay, training_pay=training_pay, labor_cost=e["total_wages"] + ot_pay)


def main(dirs):
    for d in dirs:
        g = json.load(open(os.path.join(d, "golden.json")))
        for r in g["rows"]:
            r["expected_raw"].update(row_cost(r["inputs"], r["expected_raw"]))
        for shop, t in g["corrected_location_totals_all_rows"].items():
            rows = [r["expected_raw"] for r in g["rows"] if r["inputs"]["location"] == shop]
            t["ot_pay"] = sum(x["ot_pay"] for x in rows)
            t["training_pay"] = sum(x["training_pay"] for x in rows)
            t["labor_cost"] = t["total_wages"] + t["ot_pay"]
            t["labor_cost_with_training"] = t["labor_cost"] + t["training_pay"]
            t["gross_profit_after_labor"] = t["service"] - t["labor_cost"]
        with open(os.path.join(d, "golden.json"), "w") as f:
            f.write(json.dumps(g, indent=1) + "\n")

        totals = g["corrected_location_totals_all_rows"].values()
        s = lambda k: sum(t[k] for t in totals)
        grand = dict(otPay=s("ot_pay"), trainingPay=s("training_pay"), laborCost=s("labor_cost"), laborCostWithTraining=s("labor_cost_with_training"), grossProfitAfterLabor=s("gross_profit_after_labor"))
        te = os.path.join(d, "totals_expected.json")
        if os.path.exists(te):
            want = json.load(open(te))
            want["grand"].update({k: round(v, 4) for k, v in grand.items()})
            with open(te, "w") as f:
                f.write(json.dumps(want, indent=1) + "\n")
        name = os.path.relpath(d, ROOT)
        if "private" in name:
            print(f"{name}: {len(g['rows'])} rows, {sum(1 for r in g['rows'] if r['expected_raw']['ot_pay'])} with OT pay")
        else:
            print(f"{name}: {len(g['rows'])} rows; Employee Cost {s('total_wages'):.4f} + OT pay {grand['otPay']:.4f} = labor cost {grand['laborCost']:.4f}; training pay {grand['trainingPay']:.4f} (out until Q11)")


main(sys.argv[1:] or [p for p in (os.path.join(GOLDEN, "anon"), os.path.join(GOLDEN, "private")) if os.path.exists(os.path.join(p, "golden.json"))])
