# Protocol v2 test vectors

`test/fixtures/protocol-v2-pairing.json` is a checked-in interoperability
fixture. It contains public keys only and verifies that Node and Android derive
the exact same canonical pairing transcript and six-digit comparison code.

When changing canonicalization, identity field order, or the pairing-code
derivation, update both implementations and this fixture in one commit. The
Node smoke test reads it directly. Android Gradle includes the same root
fixture directory as test resources, so Android reads the identical file rather
than a copied variant.
