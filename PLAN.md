# mcp-sheet-filler - PLAN

language: typescript

## Цель

Сделать небольшой MCP-сервер, который дает агенту инструменты для хранения и безопасного дозаполнения табличных данных.

Основной сценарий:

* В таблице есть объекты (строки) и поля (колонки).
* На листе `fields` лежит метаописание полей и инструкции для автосбора.
* Агент читает объект, вычисляет какие `auto=true` поля пустые, собирает значения, пишет обратно.
* Сервер запрещает перезаписывать уже заполненные значения.

Масштаб MVP:

* до 100 объектов
* до 100 полей

## Не-цели (в MVP не делаем)

* Параллельная запись с конфликт-резолвером и версионированием.
* Массовые операции (batch update/insert) поверх MCP.
* Сложные типы с вложенными структурами и схемами уровня JSON Schema.
* UI/веб-интерфейс.

## Хранилище

Поддерживаются 2 backend-реализации, переключение через переменные окружения:

* Google Sheets
* SQLite

Обе реализации должны вести себя одинаково по контрактам tools.

### Переменные окружения

Общие:

* `STORAGE_BACKEND` = `sheets` | `sqlite`
* `OBJECT_KEY_FIELD` = имя поля-ключа объекта, по умолчанию `name`

Sheets:

* `GOOGLE_SHEET_ID` = id таблицы
* `SHEET_TAB_DATA` = имя листа для данных, по умолчанию `data`
* `SHEET_TAB_FIELDS` = имя листа для схемы, по умолчанию `fields`
* Аутентификация: service account или OAuth2 (выбор реализации зависит от текущего MCP окружения проекта)

SQLite:

* `SQLITE_PATH` = путь к файлу БД

## Модель данных

### Лист/таблица `fields`

Колонки:

* `name` (string) - уникальное имя поля
* `description` (string) - краткое описание
* `auto` (bool) - `true/false` (может быть пустым, трактуется как `false`)
* `instructions` (string) - инструкции агенту, как собирать
* `type` (string) - тип данных (см. ниже)
* `example` (string) - пример значения

Примечания:

* `auto` допускает только `true/false`.
* `name` обязателен.

### Лист/таблица `data`

* 1 строка = 1 объект
* 1 колонка = 1 поле
* Включает колонку-ключ объекта `OBJECT_KEY_FIELD` (по умолчанию `name`).

Условие совместимости:

* Заголовки колонок `data` должны соответствовать `fields.name`.

### Правила пустоты

Чтобы одинаково работать в Sheets и SQLite:

* Пустое значение: отсутствует (sqlite), `null`, пустая строка, строка из пробелов.
* Непустое: все остальное, включая `0`, `false`, `"0"`.

## Типы данных

MVP поддерживает мягкую валидацию по `type`:

* `string` (default)
* `number`
* `date` (ISO-8601: `YYYY-MM-DD`)
* `datetime` (ISO-8601)
* `url`
* `email`
* `json` (валидный JSON в строке)
* `enum:...` (например `enum:small|medium|large`)

Поведение:

* Валидация выполняется на `save_object_no_overwrite`.
* При ошибке поле отклоняется с кодом `rejected_invalid_type`.
* Нормализация в MVP минимальная (trim). Более агрессивная нормализация - позже.

## Инструменты MCP (tools)

Все tools возвращают JSON-объекты. Ошибки - через единый формат (см. ниже).

### 1) get_fields_by_names

Получить метаописания полей по списку имен.

Input:

* `names: string[]`
* `include_instructions?: boolean` (default: true)

Output:

* `fields: Field[]`

### 2) add_field

Добавить одно поле в `fields`.

Input:

* `field: Field`

Output:

* `created: boolean`
* `field: Field`

Ограничения:

* `name` уникален.
* Если поле уже есть - ошибка `field_already_exists`.

### 3) list_fields (новый)

Получить все поля или подмножество.

Input:

* `names?: string[]`
* `include_instructions?: boolean` (default: true)

Output:

* `fields: Field[]`

### 4) get_object

Получить объект по идентификатору.

MVP вариант:

* идентификатором служит `name` (значение `OBJECT_KEY_FIELD`), поэтому `get_object` можно реализовать как алиас к `get_object_by_name`.

Input:

* `id: string` (для MVP равен `name`)

Output:

* `found: boolean`
* `object?: { name: string, values: Record<string, string> }`

### 5) get_object_by_name (новый)

То же самое, но явно по ключевому имени.

Input:

* `name: string`

Output:

* `found: boolean`
* `object?: { name: string, values: Record<string, string> }`

### 6) add_object_by_name

Добавить объект с именем (ключевым полем), без заполнения остальных.

Input:

* `name: string`

Output:

* `created: boolean`
* `object: { name: string }`

Ограничения:

* Если уже существует - ошибка `object_already_exists`.

### 7) save_object_no_overwrite

Сохранить значения для объекта без перезаписи.

Input:

* `name: string`
* `values: Record<string, string>` - patch значений

Output:

* `result: Record<string, SaveStatus>` где `SaveStatus` один из:

  * `saved`
  * `skipped_already_set`
  * `rejected_unknown_field`
  * `rejected_invalid_type`

Правила:

* Если в хранилище поле уже непустое - возвращаем `skipped_already_set`.
* Если `values` содержит поле, которого нет в `fields` - `rejected_unknown_field`.
* Если `type` не проходит валидацию - `rejected_invalid_type`.

### 8) get_missing_auto_fields (новый)

Вернуть список `auto=true` полей, которые пустые для указанного объекта.

Input:

* `name: string`
* `include_field_meta?: boolean` (default: true)

Output:

* `missing: Array<{ name: string, type?: string, example?: string, instructions?: string }>`

Алгоритм:

* Берем объект.
* Берем все поля, фильтруем `auto=true`.
* Для каждого такого поля проверяем пустоту в объекте.

## Формат сущностей

### Field

* `name: string`
* `description?: string`
* `auto?: boolean` (default false)
* `instructions?: string`
* `type?: string` (default `string`)
* `example?: string`

### Object

* `name: string` (ключ)
* `values: Record<string, string>`

## Ошибки

Единый формат error response (для случаев, когда нельзя вернуть частичный результат):

* `error: { code: string, message: string, details?: any }`

Коды MVP:

* `backend_not_configured`
* `field_already_exists`
* `field_not_found`
* `object_already_exists`
* `object_not_found`
* `invalid_argument`
* `storage_error`

Для `save_object_no_overwrite` ошибки по отдельным полям идут в `result`, а общая ошибка используется только при аварии чтения/записи.

## Реализация backend-слоя

Сделать общий интерфейс `StorageAdapter`:

* `listFields(names?: string[]): Field[]`
* `getFieldsByNames(names: string[]): Field[]`
* `addField(field: Field): void`
* `getObjectByName(name: string): Object | null`
* `addObjectByName(name: string): void`
* `saveObjectNoOverwrite(name: string, values: Record<string,string>): Record<string, SaveStatus>`

MVP требование:

* Вся логика валидации, пустоты и no-overwrite живет в общем слое, а адаптер делает только I/O.

### Sheets-адаптер

* `fields`: читаем диапазон с заголовками, строим map `name -> rowIndex`.
* `data`: читаем заголовки (первую строку) для map `fieldName -> colIndex`.
* По `name` ищем строку: линейно (100 строк) допустимо.
* Запись patch:

  * Для каждого поля: читаем текущую ячейку (можно одним range read для всех полей patch).
  * Пишем только те, где пусто.

Оптимизация для простоты:

* Для объекта читать всю строку целиком (100 колонок) нормально.
* Для `fields` читать весь лист целиком (100 строк) нормально.

### SQLite-адаптер

* Таблица `fields` как есть.
* Таблица `objects` с `data_json`.
* Для no-overwrite:

  * читаем JSON
  * для каждого поля проверяем пустоту
  * обновляем JSON только по тем, где было пусто
  * сохраняем назад

## Набор инвариантов

* `fields.name` уникален.
* `OBJECT_KEY_FIELD` существует в `data` и присутствует в `fields` (желательно, но для MVP достаточно наличия в `data`).
* `save_object_no_overwrite` никогда не изменяет непустые значения.

## Логирование и наблюдаемость

MVP:

* логировать каждый вызов tool (name, backend, latency)
* для `save_object_no_overwrite` логировать количество `saved/skipped/rejected`
* не логировать секреты и содержимое значений целиком (можно длины или первые N символов по флагу debug)

## Тестирование

MVP тесты:

* unit: пустота, валидация типов, no-overwrite
* unit: `get_missing_auto_fields` (комбинации auto true/false и пустых значений)
* integration (sqlite): полный сценарий add_field -> add_object -> save_object_no_overwrite -> get_missing
* smoke (sheets): опционально, если есть тестовая таблица и креды

## Этапы работы (MVP)

1. Каркас MCP сервера, регистрация tools.
2. Общие модели: Field/Object, пустота, валидация, ошибки.
3. SQLite адаптер (быстрый путь для разработки).
4. Реализация tools поверх адаптера.
5. Sheets адаптер.
6. Интеграционные тесты, примеры использования (README).

## Будущие улучшения (после MVP)

* `priority`, `required`, `depends_on` в `fields`.
* Batch-операции: `save_objects_no_overwrite`.
* Кеширование меты `fields` и заголовков `data`.
* Контроль конкурентной записи (etag/версия строки).
* Расширенная нормализация значений по `type`.
