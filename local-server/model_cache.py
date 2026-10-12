"""Cache LRU de modelos carregados na GPU, compartilhado por todos os backends."""

import gc
import threading
from collections import OrderedDict
from typing import Any, Callable

import torch


def free_memory() -> None:
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()


class ModelCache:
    """Mantém até `max_loaded` modelos na memória; o menos usado é descarregado primeiro."""

    def __init__(self, max_loaded: int = 2):
        self.max_loaded = max(1, int(max_loaded))
        self._models: "OrderedDict[str, Any]" = OrderedDict()
        self._lock = threading.RLock()

    def get(self, key: str, loader: Callable[[], Any]) -> Any:
        with self._lock:
            if key in self._models:
                self._models.move_to_end(key)
                return self._models[key]
            while len(self._models) >= self.max_loaded:
                self._models.popitem(last=False)
                free_memory()
            try:
                model = loader()
            except torch.cuda.OutOfMemoryError:
                # libera tudo e tenta mais uma vez antes de desistir
                self.unload()
                model = loader()
            self._models[key] = model
            return model

    def unload(self, keep: str | None = None) -> list[str]:
        with self._lock:
            removed = [k for k in self._models if k != keep]
            for k in removed:
                del self._models[k]
            free_memory()
            return removed

    def loaded(self) -> list[str]:
        with self._lock:
            return list(self._models)
