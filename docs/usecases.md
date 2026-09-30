# Stream Vy Use Cases

Actors that exist. The previous version of this file included creators,
administrators, and workers submitting films and expiring rights. There is no
creator, admin, or worker role in this product.

| ID    | Actor        | Use case                    | Authorization                                        |
| ----- | ------------ | --------------------------- | ---------------------------------------------------- |
| UC-01 | Anonymous    | Browse and search catalogue  | Public read                                           |
| UC-02 | Anonymous    | Watch an embed              | Public; the provider decides what plays               |
| UC-03 | Anonymous    | Use the local demo session  | Explicitly local-only; no server record              |
| UC-04 | Viewer       | Sign up / sign in           | Email and password                                    |
| UC-05 | Viewer       | Create a household profile  | Bearer token; max 4 per account                       |
| UC-06 | Viewer       | Unlock a profile            | The profile's own PIN, not the account password       |
| UC-07 | Viewer       | Record a taste signal       | Bearer token; derived features only                    |
| UC-08 | Viewer       | Get recommendations         | Bearer token, scoped to the active profile            |
| UC-09 | Viewer       | Claim a daily play          | Bearer token; capped at 10/profile and 20/account     |
| UC-10 | Viewer       | Apply a referral code       | Bearer token; uniqueness prevents double-claim        |
| UC-11 | Viewer       | Save / remove from My List  | Bearer token                                          |
| UC-12 | Viewer       | Record or clear history     | Bearer token                                          |
| UC-13 | Sharer       | Mint a share invite         | Bearer token                                          |
| UC-14 | Member       | Accept an invite            | Bearer token; token is the capability                 |
| UC-15 | Owner        | Remove a member / revoke    | Bearer token; owner-only, 403 otherwise               |
| UC-16 | Viewer       | Delete their account        | Bearer token **and** email and password               |

Each has an explicit authorization decision, and each is covered by a test in
`movie-backend/test_profiles_limits.py`, `test_taste.py`, or `test_shares.py`.
There is no rate limit at the API layer, which is the honest omission here.
