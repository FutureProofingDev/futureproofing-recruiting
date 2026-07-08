# Talent Development Dashboard — Setup

Dashboard por persona contratada: progreso en evaluaciones (Ashby scorecards) +
puntos a coachear + etapa de onboarding (Notion "Engineers" bench).

- **Frontend:** `public/talent.html` → se sirve en `/talent.html`
- **Backend:** `functions/api/talent.js` → endpoint `GET /api/talent`

## 1. Secrets / vars en el proyecto de Pages

```bash
# Ashby (ya configurado para /api/report — reutiliza el mismo)
wrangler pages secret put ASHBY_API_KEY --project-name futureproofing-recruiting

# Notion: token de una INTEGRACIÓN INTERNA (empieza con ntn_ o secret_)
wrangler pages secret put NOTION_API_KEY --project-name futureproofing-recruiting
```

Opcional (solo si cambias de base de hires). Por defecto apunta a la base "Engineers":

```bash
# Dashboard → Pages → futureproofing-recruiting → Settings → Variables
# NOTION_HIRES_DB_ID = 2f5ce9bd-fb9c-8092-9b87-fa02fcbf070e
```

## 2. Conectar Notion (una sola vez)

1. Ve a https://www.notion.so/my-integrations → **New integration** (internal).
2. Copia el **Internal Integration Secret** → ese es tu `NOTION_API_KEY`.
3. Abre la base **"Engineers"** (Dev PM Tracker) en Notion → menú `•••` → **Connections** →
   agrega tu integración. (Comparte también la página padre por si acaso.)

El match Ashby ↔ Notion se hace por **Candidate Email** (preferido) y, si no, por nombre.
Asegúrate de que el email del contratado en Ashby coincida con **Candidate Email** en Notion.

## 3. Deploy

```bash
wrangler pages deploy public --project-name futureproofing-recruiting
```

La función `/api/talent` se despliega sola con los archivos estáticos.
Abre `https://futureproofing-recruiting.pages.dev/talent.html`.

## 4. Afinar el parser de scorecards (importante)

La forma exacta del feedback/scorecard varía por org en Ashby. El parser es defensivo,
pero conviene validarlo contra tu data real. Abre:

```
https://futureproofing-recruiting.pages.dev/api/talent?debug=1
```

Eso devuelve JSON con:
- `debug.matchedJobs` — los puestos de AI Engineer detectados
- `debug.feedbackSample` — **el payload crudo del primer scorecard** (clave para afinar)
- `debug.noteSample` — **el primer note de HackerEval** (las evaluaciones de HackerEval
  viven en los notes de Ashby; este es el ejemplo para afinar el parser)
- `debug.notionStagesSeen` / `debug.notionRecordCount` — qué leyó de Notion
- `debug.errors` — errores de Notion (p. ej. permisos)

Pásame ese JSON (sobre todo `feedbackSample` y `noteSample`) y ajusto el mapeo de
atributos/scores para que las competencias y el progreso salgan exactos.

## Cómo se calcula

| Sección | Fuente | Lógica |
|---|---|---|
| Score promedio / progreso | Ashby scorecards (`applicationFeedback.list`) + **notes de HackerEval** (`applicationNote.list`) | Score "overall" (o promedio de atributos) por evaluación, en orden cronológico |
| Competencias | Ashby scorecards + HackerEval | Promedio por atributo a lo largo de todas las evaluaciones |
| Puntos a coachear | Ashby scorecards + HackerEval | Atributos con promedio < 60/100 (rojo < 40, ámbar 40–59) |
| Pipeline onboarding | Notion `Weekly Update Stage` | Stepper ordenado 1→7 |
| Milestones | Notion `Onboarding Stage` (multi-select) | Checklist de hitos completados vs faltantes |
| Readiness | Notion `AI Tooling` (status) | Bench & Build → Scaling Ready → Production Ready |

Caché: 5 min (Cloudflare Cache API). Forzar refresco: `/api/talent?fresh=1` o botón **Actualizar**.
