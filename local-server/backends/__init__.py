"""Backends de modelos locais. Cada backend expõe suas rotas em server.py."""


class UserError(Exception):
    """Erro causado pela requisição (parâmetro inválido, modelo não baixado…) — vira HTTP 400."""
