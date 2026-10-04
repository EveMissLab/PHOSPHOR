"""Demo target for phosphor_graph explosion-prevention tests.

Calls the same function many times in a tight loop. A real trace of this
script produces one viztracer "X" event *per call* (hundreds of them), but
should fold down to a small, fixed number of graph nodes (one per distinct
(file, function) pair) -- this script is what proves that on real captured
data, not just a synthetic TraceEvent list.
"""

N_CALLS = 500


def square(x):
    return x * x


def main():
    total = 0
    for i in range(N_CALLS):
        total += square(i)
    print(f"sum of squares up to {N_CALLS} = {total}")


if __name__ == "__main__":
    main()
