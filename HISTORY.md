# HISTORIAL DE REVISIÓN DE TESIS UNIVERSITARIAS - PROYECTO DE IA

## Proyecto

Sistema de revisión automatizada de tesis universitarias utilizando IA, basado en:

- Guía GT de Universidad Mariano Gálvez
- Normas APA 6ta edición
- Revisión ortográfica, gramatical y de redacción
- Detección de gerundios, muletillas y problemas de estilo
- Validación estructural de tesis
- Generación automática de reportes y matrices

---

# Objetivo General

Construir una plataforma asistida por IA que permita:

1. Revisar tesis automáticamente.
2. Detectar incumplimientos de formato y contenido.
3. Generar observaciones académicas detalladas.
4. Insertar comentarios directamente sobre documentos.
5. Generar matrices de congruencia.
6. Validar alineación entre:
   - Problema
   - Objetivos
   - Conclusiones
   - Recomendaciones

---

# Estado Actual del Proyecto

## Fase

Investigación + definición arquitectónica inicial.

## Estado

MVP conceptual definido.

## Componentes identificados

### Backend

- Node.js
- Laravel (evaluado)
- APIs REST
- OCR/PDF Parsing
- DOCX Parsing

### Frontend

- Angular + Ionic
- Dashboard administrativo
- Gestión de revisiones
- Carga de tesis

### IA

- OpenAI
- RAG
- MCP
- Embeddings
- Procesamiento contextual de documentos

### Almacenamiento

- OneDrive institucional
- Google Drive (evaluado)
- GitHub
- Vector DB (pendiente definición)

---

# Decisiones Técnicas Importantes

## Arquitectura

Se contempla:

- Monorepo
- Backend desacoplado
- Frontend Angular/Ionic
- Servicio IA independiente

## Procesamiento documental

El sistema debe:

- Leer PDF y DOCX
- Extraer estructura
- Identificar capítulos
- Detectar:
  - Gerundios
  - Muletillas
  - Voz pasiva
  - Frases extensas
  - Errores APA
  - Problemas ortográficos
  - Problemas gramaticales

## Reglas críticas

Los reportes SIEMPRE deben indicar:

- Capítulo
- Página
- Evidencia encontrada
- Tipo de error

## Reportes requeridos

- Reporte Markdown
- Reporte Word
- Matriz XLSX
- Evidencia de errores

---

# Reglas Académicas

## Guía GT

Se utiliza:

- "Tesis Guia de Trabajo GT.pdf"

Validaciones:

- Márgenes
- Fuente
- Interlineado
- Redacción impersonal
- Justificación
- Numeración
- Estructura formal

## APA

Se utiliza:

- "norma-apa.pdf"

Validaciones:

- Citas
- Referencias
- Tablas
- Figuras
- Sangría francesa
- Formato APA 6

---

# Observaciones Detectadas en Revisiones

## Problema recurrente detectado

Los reportes iniciales no indicaban:

- Página exacta
- Capítulo exacto
- Ubicación precisa de:
  - Gerundios
  - Muletillas
  - Errores ortográficos
  - Problemas de redacción

## Corrección requerida

Todos los reportes futuros deben incluir:

- Evidencia específica
- Ubicación exacta
- Contexto textual

---

# Tesis Revisadas

## Allan Carlos Manuel Valencia Arriola

Tema:
Sistema Zenticket’s.

Hallazgos:

- Problemas de estructura
- Errores ortográficos menores
- Problemas de consistencia en numeración
- Repetición de encabezados
- Uso inconsistente de mayúsculas
- Problemas APA menores

## William Geovanny Aroche Contreras

Tema:
Sistema web para gestión administrativa.

Hallazgos:

- Buen nivel estructural
- Algunos problemas de redacción
- Uso excesivo de citas largas
- Problemas menores APA

## Oscar Elías Castellanos Cordero

Tema:
Sistema de ventas e inventario con FEL.

Hallazgos:

- Documento más moderno y consistente
- Mejor fundamentación bibliográfica
- Problemas de estilo menores
- Introducción incompleta en algunas versiones

---

# Observaciones Estratégicas

## OneDrive

Se discutió:

- Integración OneDrive + IA
- Automatización institucional
- RAG sobre documentos académicos

## Codex

Se definió:

- Codex NO hereda automáticamente conversaciones ChatGPT.
- Debe usarse:
  - HISTORY.md
  - README.md
  - AGENTS.md
  - prompts/
  - docs/

---

# Próximos Pasos

## Prioridad Alta

1. Crear AGENTS.md
2. Crear README.md
3. Definir estructura monorepo
4. Implementar parser PDF/DOCX
5. Crear motor de validación GT + APA

## Prioridad Media

1. Integrar OneDrive
2. Integrar comentarios automáticos DOCX
3. Crear sistema de embeddings
4. Implementar RAG

## Prioridad Baja

1. Multiusuario
2. Panel docente
3. Dashboard estadístico
4. Historial de revisiones

---

# Notas Operativas

## Convención

Todos los reportes deben:

- Ser detallados
- Tener evidencia
- Incluir ubicación exacta
- Mantener tono académico formal

## Reglas de calidad

Nunca generar:

- Hallazgos sin evidencia
- Correcciones ambiguas
- Observaciones genéricas

## Filosofía del sistema

El sistema debe comportarse como:

- Revisor académico universitario
- Asesor metodológico
- Corrector de estilo
- Validador APA/GT
- Auditor de congruencia académica
