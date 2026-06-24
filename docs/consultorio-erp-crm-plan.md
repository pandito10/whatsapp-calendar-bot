# ERP/CRM para consultorios

Este documento aterriza la idea del ERP/CRM para consultorios sobre el proyecto actual `whatsapp-calendar-bot`.

## Vision

Construir una plataforma para consultorios donde la recepcion, el medico y la administracion trabajen desde un solo lugar:

- WhatsApp y agenda.
- CRM de pacientes.
- Expediente clinico.
- Archivos y resultados.
- Recetas, constancias y PDFs.
- Cobranza, caja e inventario.
- Reportes del consultorio.
- Roles para recepcion, doctores y administracion.

El bot actual debe convertirse en el modulo de entrada: recibe pacientes, agenda, guarda conversaciones y pasa casos delicados a humano. El ERP/CRM debe crecer alrededor sin romper el bot.

## Que ya existe

El proyecto actual ya cubre una base importante:

- WhatsApp Cloud API.
- Webhook firmado de Meta.
- Inbox web.
- Modo humano.
- Google Calendar.
- Supabase/Postgres.
- Citas en Supabase.
- Conversaciones y mensajes.
- Envio seguro de resultados por correo confirmado.
- Bloqueo de resultados/archivos por WhatsApp.
- Reglas medicas seguras.

Esto es la base del modulo de recepcion digital.

## MVP recomendado

No conviene construir todo el ERP de golpe. El primer producto vendible debe enfocarse en recepcion + agenda + CRM ligero.

### Fase 1: CRM operativo del consultorio

Objetivo: que la doctora o asistente pueda ver a cada paciente como ficha, no solo como chat.

Incluye:

- Ficha del paciente.
- Historial basico de citas.
- Numero de consultas.
- Etiquetas.
- Notas internas.
- Archivos asociados al paciente.
- Resultados enviados por correo.
- Estado del paciente: nuevo, activo, pendiente, humano, cancelado.
- Busqueda por nombre, telefono y correo.

Tablas sugeridas:

- `patients`
- `patient_notes`
- `patient_files`
- `patient_tags`
- `patient_activity`

### Fase 2: Expediente clinico

Objetivo: que cada consulta genere una nota clinica organizada.

Incluye:

- Consulta #1, #2, #3, etc.
- Motivo de consulta.
- Evolucion.
- Diagnostico.
- Tratamiento.
- Observaciones.
- Proxima cita recomendada.

Importante: esto requiere mas cuidado legal y privacidad. Debe estar detras de login fuerte, roles y auditoria.

Tablas sugeridas:

- `clinical_encounters`
- `clinical_notes`
- `prescriptions`
- `medical_documents`
- `audit_logs`

### Fase 3: Recetas y documentos PDF

Objetivo: generar documentos bonitos y reutilizables.

Incluye:

- Recetas.
- Constancias.
- Referencias.
- Indicaciones.
- Certificados.

Regla: no enviar documentos medicos por WhatsApp salvo que el consultorio tenga politica explicita y consentimiento. Por defecto, correo confirmado o entrega presencial.

### Fase 4: Cobranza y caja

Objetivo: convertir el consultorio en un punto de venta simple.

Incluye:

- Registrar pago de consulta.
- Efectivo, transferencia, tarjeta o mixto.
- Recibos.
- Corte de caja.
- Ingresos por dia.
- Adeudos.

Tablas sugeridas:

- `cash_registers`
- `payments`
- `payment_items`
- `receipts`

### Fase 5: Inventario

Objetivo: controlar productos si el consultorio vende articulos.

Incluye:

- Productos.
- Existencias.
- Costo.
- Precio de venta.
- Movimientos.
- Alertas de bajo stock.

Tablas sugeridas:

- `products`
- `inventory_movements`
- `inventory_adjustments`

### Fase 6: SaaS multi-consultorio

Objetivo: venderlo a varios consultorios.

Incluye:

- `clinics` o `businesses`.
- Usuarios por clinica.
- Roles.
- Numeros de WhatsApp por clinica.
- Calendarios por clinica.
- Configuracion por clinica.
- Reportes por clinica.

Esto no debe hacerse antes de estabilizar el piloto con un consultorio real.

## Arquitectura recomendada

### Ahora

Mantener el stack actual:

- Node.js sin framework pesado.
- Supabase/Postgres.
- Render.
- WhatsApp Cloud API.
- Google Calendar.
- Inbox web server-rendered.

Motivo: ya funciona, es barato, rapido de ajustar y suficiente para piloto.

### Despues

Cuando el producto tenga clientes reales:

- Frontend: Next.js o app separada.
- Backend: Node/NestJS o API modular.
- Base: PostgreSQL.
- Storage: Supabase Storage o S3 compatible.
- Calendario UI: FullCalendar.
- PDFs: generacion server-side.
- Jobs: worker separado para recordatorios, reportes y mantenimiento.

## Prioridad real de construccion

1. CRM de pacientes dentro del inbox actual.
2. Archivos por paciente, enviados por correo confirmado.
3. Historial de citas y contador de consultas.
4. Notas internas mejoradas.
5. Busqueda global de pacientes.
6. Dashboard operativo.
7. Expediente clinico basico.
8. Recetas PDF.
9. Caja/cobranza.
10. Inventario.
11. Multi-consultorio SaaS.

## Riesgos importantes

- Datos de salud: requieren privacidad fuerte y aviso de privacidad.
- WhatsApp: no debe usarse para diagnosticar ni mandar resultados sensibles.
- Expediente clinico: requiere permisos por rol y auditoria.
- Archivos: no guardar documentos medicos en lugares publicos.
- Multi-cliente: no mezclar datos entre consultorios.
- Cobranza: si se mete facturacion real, revisar normativa fiscal.

## Primer entregable recomendado

Crear un "CRM medico ligero" dentro del inbox:

- Ficha consolidada de paciente.
- Consultas/citas anteriores.
- Proxima cita.
- Total de citas.
- Archivos enviados por correo.
- Notas internas.
- Etiquetas.
- Boton "Nueva nota".
- Boton "Subir archivo al correo confirmado".
- Boton "Ver historial".

Esto se puede construir sin rehacer el sistema y ya haria que el producto se sienta mucho mas premium.

## Decision

La mejor ruta no es crear otro proyecto desde cero hoy. La mejor ruta es:

1. Mantener el bot actual como recepcion automatizada.
2. Convertir el inbox en CRM operativo.
3. Agregar expediente y caja por fases.
4. Solo despues separar frontend/backend si el negocio ya lo pide.

