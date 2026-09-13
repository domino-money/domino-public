"""Disabled private performance gateway. No CLI, listener port or deployment."""
from types import SimpleNamespace

from authenticated_api import AuthenticatedGateway, create_authenticated_app
import performance_models as models

PREFIX = '/internal/performance/v1/'
HEADER = 'X-Domino-Performance-Contract'
CONTRACT = SimpleNamespace(PREFIX=PREFIX, HEADER=HEADER, Error=models.PerformanceError,
    CONTRACT_VERSION=models.CONTRACT_VERSION, MAX_BODY=models.MAX_BODY,
    MAX_RESPONSE=models.MAX_RESPONSE, REQUEST_MODELS=models.REQUEST_MODELS,
    CAPACITY_CODE='performance_capacity_busy', validate_request=models.validate_request,
    validate_response=models.validate_response)


class PerformanceGateway(AuthenticatedGateway):
    def __init__(self, **kwargs):
        super().__init__(contract=CONTRACT, **kwargs)


def create_performance_app(gateway=None):
    return create_authenticated_app(gateway or PerformanceGateway())
