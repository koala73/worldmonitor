# Media provenance fixtures (#9096)

`c2pa-store-*.json` are the exact `Reader.json()` output of
`@contentauth/c2pa-node` 0.9.9 for one synthetic 64x48 JPEG signed with a
throwaway test CA (CN "Example Newsroom Signer", O "Example Newsroom (test)"):

- `trusted`: read with that test CA as the trust anchor.
- `untrusted`: read with the library defaults (no trust anchors).
- `tampered`: one byte of the signed file flipped after signing, read with the defaults.
- `tampered-trusted`: the same file read with the test CA as the trust anchor.

The manifest declares `c2pa.created` with the IPTC
`trainedAlgorithmicMedia` source type, then `c2pa.cropped`. No real
publisher, camera or person is named.

`tineye-search.json` is a synthetic TinEye search response in the shape
TinEye's own client libraries parse (`results.matches[].backlinks[]` with
`crawl_date` as YYYY-MM-DD). Every domain is an example domain.
