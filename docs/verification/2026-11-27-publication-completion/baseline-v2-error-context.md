# Page snapshot

```yaml
- generic [ref=e3]:
  - complementary "Доступ к черновику" [ref=e4]:
    - paragraph [ref=e5]: Черновик открыт для редактирования в этой вкладке.
    - button "Освободить черновик" [ref=e7] [cursor=pointer]
  - generic [ref=e8]:
    - banner [ref=e9]:
      - button "SEJIRE" [ref=e10] [cursor=pointer]: SEJIRE
      - radiogroup "Язык" [ref=e12]:
        - radio "ҚАЗ" [ref=e13] [cursor=pointer]
        - radio "РУС" [checked] [ref=e14] [cursor=pointer]
        - radio "ENG" [ref=e15] [cursor=pointer]
    - main [ref=e16]:
      - heading "Админ-панель" [level=1] [ref=e17]
      - paragraph [ref=e18]: Оплата Solana, промокод и фонд хранения. Семейные архивы остаются зашифрованными.
      - region "Управление сохранениями" [ref=e19]:
        - generic [ref=e20]:
          - paragraph [ref=e21]: Войдите с паролем администратора сервера. Права проверяются сервером; слова кошелька и архива здесь не нужны.
          - generic [ref=e22]:
            - text: Пароль
            - textbox "Пароль" [ref=e23]: Synthetic admin password for tests 2026!
          - button "Показать пароль" [ref=e24] [cursor=pointer]
          - button "Войти" [ref=e25] [cursor=pointer]
        - alert [ref=e26]: Не удалось подтвердить результат запроса. Обновите данные перед повторным действием.
```