# Multiparty Computation Protocol

The undetectability in the signing process is quite fascinating. It's achieved through a clever combination of cryptographic techniques:

1\. Threshold ECDSA: This allows the signature to be created without any single party knowing the full private key.

2\. Homomorphic encryption: During signing, all intermediate values are encrypted. Parties perform computations on these encrypted values, never seeing the actual data.

3\. Zero-knowledge proofs: These verify that each party is following the protocol correctly without revealing any information about their secret share.

The private key remains a phantom throughout, influencing the process but never materializing.
