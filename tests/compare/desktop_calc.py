# Runs the desktop scheduler's own _calc() (scheduler/justbread_scheduler.py)
# without a GUI, for a list of (loaves, done_by_seconds) cases read as JSON on
# stdin. Prints the schedule each case produces, as JSON. Used only by
# tests/unit/production.test.js to prove the web port matches.
import sys, os, json, types
from datetime import datetime

# Stub the GUI/PDF modules the file imports; _calc() uses none of them.
tk = types.ModuleType('tkinter')
class _Tk:  # App subclasses tk.Tk
    pass
tk.Tk = _Tk
tk.ttk = types.ModuleType('tkinter.ttk')
sys.modules['tkinter'] = tk
sys.modules['tkinter.ttk'] = tk.ttk
rl = types.ModuleType('reportlab'); rlp = types.ModuleType('reportlab.pdfgen'); rlp.canvas = types.ModuleType('reportlab.pdfgen.canvas')
sys.modules.update({'reportlab': rl, 'reportlab.pdfgen': rlp, 'reportlab.pdfgen.canvas': rlp.canvas})

here = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(here, '..', '..', 'scheduler'))
import justbread_scheduler as js

class Var:
    def __init__(self, v): self.v = v
    def get(self): return self.v

out = []
for case in json.load(sys.stdin):
    secs = case['done_secs']
    done = datetime(2026, 11, 12, secs // 3600, (secs % 3600) // 60, secs % 60)
    js.parse_t = lambda s, done=done: done  # accept the exact time, seconds included
    fake = types.SimpleNamespace(
        lv={d: Var(str(case['loaves']) if d == 'Thursday' else '0') for d in js.DAYS},
        tv={d: Var('x' if d == 'Thursday' else '') for d in js.DAYS},
    )
    (totals, acts), err = js.App._calc(fake)
    starter = acts[1][0][1]; dough = acts[2][0][1]; bake = acts[3][0][1]
    out.append({
        'totals': {'loaves': totals['loaves'], 'starter': totals['starter'], 'fridge_starter': js.grams(totals['fridge_starter']),
                   'flour': totals['flour'], 'water': totals['water'], 'salt': totals['salt']},
        'tuesday': {'pull': js.grams(starter['pull']), 'after1': js.grams(starter['after1']), 'total': js.grams(starter['total'])},
        'wednesday': {'start': js.fmt(dough['mix']), 'flour': js.supply_line(dough['flour'], js.BAG_G, 'bag'),
                      'water': js.supply_line(dough['water'], js.GALLON_G, 'gallon'), 'salt': js.grams(dough['salt']),
                      'starter': js.grams(dough['starter']), 'steps': [[n, js.fmt(t)] for n, t in dough['steps']]},
        'thursday': {'batches': bake['batches'], 'done_by': js.fmt(js.r5(bake['done_by'])), 'events': [[n, js.fmt(t)] for n, t in bake['events']]},
    })
print(json.dumps(out))
