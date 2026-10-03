# Offline password rejection corpus

Only SHA-256 blocklist entries are bundled here. These hashes represent publicly
documented weak/compromised candidates, not account credentials. Accepted staff
passwords are stored separately using Argon2id.

Source: SecLists' `Passwords/Common-Credentials/xato-net-10-million-passwords-1000000.txt`,
licensed by that project under MIT; its full notice is in `SecLists.LICENSE`.
The [maintainer's description](https://github.com/danielmiessler/SecLists/blob/master/Passwords/Common-Credentials/README.md)
documents the Xato list as sorted from most common to least common. The
[original publisher](https://medium.com/xato-security/today-i-am-releasing-ten-million-passwords-b6278bbe7495)
describes public research data compiled from historical leaks. We retrieved
only the password-only SecLists subset, never usernames, domains or account
combinations; this derivative is used solely to reject unsafe new credentials.

`password_blocklist.json` pins the exact upstream source SHA-256, byte and line
counts, matching-policy count and derivative checksum. The reviewed 1,000,000
entry snapshot contains 46,296 distinct strict-UTF-8 entries of 12–128 characters;
only the first 3,000 matching the application's length policy are selected,
plus the first 10,000 historical compromised candidates in source frequency
order. The derivative includes exact and casefold lookup variants and remains
under 1 MB. The list is a bounded historical sample: absence is not evidence
that a password was never leaked.

Generation never modifies a user's actual credential. Casefold is used only
to reject candidate variations, while Argon2 hashes the exact supplied text.
The source plaintext was processed in memory and is not stored in this repo.
Runtime performs no remote queries and sends neither passwords nor hashes.
Missing/corrupt bundled data blocks new password operations with 503.

To reproduce, obtain the exact reviewed snapshot and upstream license outside
Git, then run `python scripts/build_password_blocklist.py --source-file <local-file> --license-file <local-license>`.
The script verifies pinned source/license checksums and writes only derived
hashes and metadata. Updating the corpus requires reviewing its provenance and
changing the pinned source and runtime artifact checksum deliberately.

Organization/role context words are enumerated in `app/password_policy.py`:
Nankai/NankaiUniversity, TwinNKU, NKGenios, Xiaokai, 南开/南开大学/小开/津南/八里台,
2512921/2512921.cn, and the actual staff role names. These and a small documented
set of obvious weak bases are rejected when only digits/punctuation surround
the base. Other long phrases and arbitrary Unicode composition remain valid;
no mandatory uppercase/digit/symbol mixture or periodic rotation is introduced.
