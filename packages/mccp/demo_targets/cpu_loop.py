"""CPU/loop-heavy demo target for PHOSPHOR MCCP's first milestone demo.

Unfamiliar-to-the-pipeline, real Python script with no I/O: a naive
(exponential-time) recursive Fibonacci plus a small hand-rolled matrix
multiplication workload. Both call the *same* handful of functions
thousands of times over, so a real viztracer capture of this script produces
well over 200 "X" (function_call) events while still folding down to a
small, fixed set of (file, function) graph nodes -- exactly the case
phosphor_graph's node/edge aggregation (one node no matter how many calls)
needs to prove itself against real captured data, not a synthetic
TraceEvent list.

Standalone: no CLI args, no network, no files written. Finishes in well
under a second of wall-clock time (excluding tracing overhead).
"""


def fibonacci(n):
    """Naive recursive Fibonacci -- deliberately O(2^n) calls, not O(n).

    fibonacci(17) alone makes several thousand recursive calls, all landing
    on this one (file, function) pair, so it is the main source of the
    "same function, many calls" pressure this demo target is for.
    """
    if n < 2:
        return n
    return fibonacci(n - 1) + fibonacci(n - 2)


def matrix_multiply_element(row, col):
    """Dot product of one output cell -- called once per (row, col) pair."""
    return sum(a * b for a, b in zip(row, col))


def multiply_matrices(a, b):
    """Naive O(n^3) matrix multiply, one function call per output cell."""
    b_columns = list(zip(*b))
    return [[matrix_multiply_element(row, col) for col in b_columns] for row in a]


def build_matrix(size, seed):
    """Small deterministic (no randomness) size x size matrix of ints."""
    return [[(seed + i * size + j) % 7 for j in range(size)] for i in range(size)]


def run_matrix_workload(size, iterations):
    """Build and multiply a fresh pair of matrices `iterations` times over,
    exercising build_matrix/multiply_matrices/matrix_multiply_element in a
    nested-loop-driven, repeated-call pattern distinct from the recursive
    fibonacci path above.
    """
    total = 0
    for i in range(iterations):
        a = build_matrix(size, i)
        b = build_matrix(size, i + 1)
        product = multiply_matrices(a, b)
        total += sum(sum(row) for row in product)
    return total


def main():
    fib_n = 17
    fib_result = fibonacci(fib_n)
    print(f"fibonacci({fib_n}) = {fib_result}")

    matrix_size = 6
    matrix_iterations = 20
    matrix_total = run_matrix_workload(matrix_size, matrix_iterations)
    print(f"matrix workload ({matrix_iterations} x {matrix_size}x{matrix_size}) total = {matrix_total}")


if __name__ == "__main__":
    main()
