module.exports = /*@ngInject*/($scope, $state, co, user, signUp) => {
	if (!signUp.tokenSignup || !signUp.plan)
		$state.go('invite');

	$scope.form = signUp.details ? signUp.details : {
		firstName: '',
		lastName: '',
		displayName: ''
	};

	$scope.$watchGroup(['form.firstName', 'form.lastName'], () => {
		var firstName = $scope.form.firstName ? $scope.form.firstName.trim() : '';
		var lastName = $scope.form.lastName ? $scope.form.lastName.trim() : '';
		var autoDisplayName = `${firstName} ${lastName}`;

		$scope.form.displayName = firstName || lastName ? autoDisplayName : $scope.form.displayName;
	});

	$scope.requestDetailsUpdate = () => co(function *(){
		signUp.details = $scope.form;

		yield $state.go('choosePasswordIntro');
	});
};
