# FreeStream Use Cases

| ID    | Actor   | Use case               | Required policy                                     |
| ----- | ------- | ---------------------- | --------------------------------------------------- |
| UC-01 | Viewer  | Search catalogue       | Public read, rate limited                           |
| UC-02 | Viewer  | View movie page        | Published record only                               |
| UC-03 | Viewer  | Start playback         | Valid rights, source, media, territory, date        |
| UC-04 | Viewer  | Save title             | Authenticated user                                  |
| UC-05 | Viewer  | Resume playback        | Authenticated user or approved anonymous policy     |
| UC-06 | Viewer  | Review title           | Authenticated, rate limited, moderated              |
| UC-07 | Creator | Submit film            | Creator role, upload validation, rights declaration |
| UC-08 | Admin   | Publish title          | Admin role plus rights and media readiness          |
| UC-09 | Admin   | Edit metadata          | Admin role, provenance preservation                 |
| UC-10 | Admin   | Moderate review        | Moderator permission and audit event                |
| UC-11 | Worker  | Sync provider metadata | Signed/configured provider credentials              |
| UC-12 | Worker  | Expire playback rights | Rights policy and audit trail                       |

Each use case must have a success state, a recoverable failure state, an authorization decision, rate limits where public input exists, and telemetry that does not collect unnecessary personal data.
