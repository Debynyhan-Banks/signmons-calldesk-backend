# Backend Screen Vocabulary Map

Purpose: prevent naming drift between historical backend screen IDs (`SCR-TEN-*`) and canonical governance IDs (`SCR-PUB-*`, `SCR-APP-*`).

## Canonical Source

- `/Users/debynyhanbanks/Web Projects/signmons-governance/SCREEN_INVENTORY.md`

## Translation Table (Legacy -> Canonical)

| Legacy ID (backend history) | Canonical ID | Surface |
| --- | --- | --- |
| `SCR-TEN-006` | `SCR-APP-014` | Dispatch board |
| `SCR-TEN-007` | `SCR-APP-017` | Job assignment detail |
| `SCR-TEN-008` | `SCR-APP-015` / `SCR-APP-025` | Schedule / availability |
| `SCR-TEN-009` | `SCR-APP-020` | Call quality analytics |
| `SCR-TEN-010` | `SCR-APP-018` / `SCR-APP-019` | Revenue + funnel analytics |
| `SCR-TEN-011` | `SCR-APP-007` / `SCR-APP-023` | Tenant settings + payment policy |
| `SCR-TEN-012` | `SCR-APP-021` / `SCR-APP-022` | Notification center + templates |

## Public Surfaces With Backend Dependencies

| Canonical Screen ID | Route | Backend Dependency |
| --- | --- | --- |
| `SCR-PUB-007` | `/demo` | try-demo endpoints |
| `SCR-PUB-009` | `/contact` | lead-capture endpoint |
| `SCR-PUB-012` | `/business-rules` | display dependency only (`BusinessRuleSet`) until APP-017 |
| `SCR-PUB-013` | `/brand-voice` | display dependency only (`TenantBrandProfile`) until APP-018 |

## Rule

New backend work must reference canonical governance screen IDs in tickets, PRs, and handoff notes.
