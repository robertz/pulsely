#!/usr/bin/env bash
# Compiles java/socketbox-shim's sources into lib/java/pulsely-socketbox-shim.jar
# (tracked in git - lib/** is gitignored except lib/java/). Run manually
# after editing src/**, commit both the source change and the regenerated jar.
set -euo pipefail
cd "$(dirname "$0")"

rm -rf classes
mkdir -p classes
javac -d classes --release 21 src/pulsely/socketbox/*.java

mkdir -p ../../lib/java
jar --create --file ../../lib/java/pulsely-socketbox-shim.jar -C classes .

rm -rf classes
echo "Built lib/java/pulsely-socketbox-shim.jar"
