Commit and content guard, mirrored from the guard.py that the maintainers' local commit hooks run. Keep the copies identical.
CI runs the copy from the base revision of the checked range (the commit's own copy only when the base has none):
python3 guard.py ci --range BASE..HEAD
